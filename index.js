import express from "express";
import path from "path";
import { GoogleGenAI, Modality } from "@google/genai";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import multer from "multer";
// import fs from "fs";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import fs from "fs-extra";
import dotenv from "dotenv";
import http from "http";
import https from "https";
dotenv.config();

// Configure multer to use disk storage for larger files
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "/tmp/"); // Save to tmp directory
  },
  filename: function (req, file, cb) {
    cb(
      null,
      file.fieldname + "-" + Date.now() + path.extname(file.originalname)
    );
  },
});

const upload = multer({ storage: multer.memoryStorage() });
const app = express();
const server = http.createServer(app);
// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Definisikan TEMP_DIR sebagai variabel global
const TEMP_DIR = path.join(__dirname, "temp");
// Pastikan direktori temp ada dengan izin yang cukupffprobe
fs.ensureDirSync(TEMP_DIR, { mode: 0o755 });

// Initialize express app
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json()); // Increased limit for larger JSON payloads
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: true }));
server.setTimeout(3600000);

app.get("/", (req, res) => {
  res.send("backend content");
});

app.post("/api/gemini", upload.single("file"), async (req, res) => {
  try {
    let model = req.body.model;
    let prompt = req.body.prompt;
    const file = req.file;

    const parts = [{ text: prompt }];

    if (file) {
      const mimeType = file.mimetype;
      const imageData = file.buffer.toString("base64");

      parts.push({
        inlineData: {
          mimeType,
          data: imageData,
        },
      });
    }

    const config = {
      responseModalities: ["IMAGE", "TEXT"],
      responseMimeType: "text/plain",
    };

    const ai = new GoogleGenAI({
      apiKey: process.env.GOOGLE_GENAI_API_KEY,
    });

    const contents = [
      {
        role: "user",
        parts: parts,
      },
    ];

    const response = await ai.models.generateContent({
      model,
      config,
      contents,
    });

    res.status(200).json({ status: 200, data: response });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 500, message: error.message });
  }
});

app.post("/api/audio", upload.single("audio"), async (req, res) => {
  try {
    // Check if file was uploaded
    if (!req.file) {
      return res.status(400).json({ error: "No audio file uploaded" });
    }

    console.log("Audio file info:", req.file); // Log file info for debugging

    // Use the path property from multer
    ffmpeg.ffprobe(req.file.path, function (err, metadata) {
      if (err) {
        console.error("FFprobe error:", err);
        return res.status(500).json({ error: err.message });
      }

      const duration = Math.ceil(metadata.format.duration);
      const name = req.file.originalname;
      res.status(200).json({ status: 200, duration: duration, name: name });
    });
  } catch (error) {
    console.error("General error:", error);
    res.status(500).json({ status: 500, error: error.message });
  }
});

app.use(
  "/api/audio-buffer",
  express.raw({ type: "audio/mpeg", limit: "10mb" })
);

app.post("/api/audio-buffer", async (req, res) => {
  try {
    const buffer = req.body;

    // Save to file (optional)
    const outputPath = await path.join(__dirname, "output_audio.mp3");
    // Delete previous file if exists to avoid accumulation

    await fs.writeFileSync(outputPath, buffer);

    // You can also analyze the audio with ffmpeg if needed
    const tunggu = await ffmpeg.ffprobe(outputPath, function (err, metadata) {
      if (err) {
        console.error("FFprobe error:", err);
        return res.status(500).json({ error: err.message });
      }
      // Assuming metadata.format.duration is the audio durati
      const duration = metadata.format
        ? `${Math.floor(Math.ceil(metadata.format.duration) / 60)}:${String(
            Math.ceil(metadata.format.duration) % 60
          ).padStart(2, "0")}`
        : 0;
      res.json({
        message: "Audio buffer received and converted successfully!",
        duration: duration,
        size: metadata.format.size / (1024 * 1024),
        format: metadata.format.format_name,
        bitrate: metadata.format.bit_rate,
        start_time: metadata.format.start_time,
      });
      fs.unlinkSync(outputPath);
    });
  } catch (error) {
    fs.unlinkSync(outputPath);
    console.log(error);
    res.status(500).json({ error: error.message });
  }
});

// Fungsi untuk validasi format file dengan ffprobe sebelum memproses
function validateMediaFile(filePath, type) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`Invalid ${type} file: ${filePath}`, err);
        return reject(new Error(`Invalid ${type} file: ${filePath}`));
      }

      // Validasi format sesuai tipe
      if (
        type === "audio" &&
        (!metadata.streams ||
          !metadata.streams.some((s) => s.codec_type === "audio"))
      ) {
        return reject(new Error(`File is not a valid audio: ${filePath}`));
      }
      if (
        type === "image" &&
        (!metadata.streams ||
          !metadata.streams.some((s) => s.codec_type === "video"))
      ) {
        return reject(new Error(`File is not a valid image: ${filePath}`));
      }

      resolve(metadata);
    });
  });
}

// Fungsi untuk mendapatkan durasi audio - DIPERBAIKI
function getAudioDuration(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) {
        console.error(`Error getting duration for ${audioPath}:`, err);
        return reject(err);
      }
      const duration = metadata.format.duration;
      console.log(`Duration for ${path.basename(audioPath)}: ${duration}s`);
      resolve(duration);
    });
  });
}

// Alternative version dengan pendekatan yang lebih sederhana
function trimAudio(inputPath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      return reject(new Error("Input audio file not found"));
    }

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    function isSameFilePath(inputPath, outputPath) {
      const resolvedInput = path.resolve(inputPath);
      const resolvedOutput = path.resolve(outputPath);

      return resolvedInput === resolvedOutput;
    }

    if (isSameFilePath(inputPath, outputPath)) {
      const tempOutput = outputPath + ".tmp.mp3";
      ffmpeg(inputPath)
        .format("mp3")
        .duration(duration)
        .audioCodec("libmp3lame")
        .audioBitrate("128k")
        .audioChannels(2)
        .audioFrequency(44100)
        .output(tempOutput)
        .on("start", (cmd) => {
          console.log("Trim command:", cmd);
        })
        .on("end", () => {
          fs.renameSync(tempOutput, outputPath); // Ganti file lama
          console.log(`Trim completed: ${path.basename(outputPath)}`);
          resolve();
        })
        .on("error", (err) => {
          console.error("Trim error:", err);
          if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
          reject(err);
        })
        .run();
    } else {
      // Approach yang lebih sederhana tanpa ffprobe dulu
      ffmpeg(inputPath)
        .format("mp3") // Set output format explicitly
        .duration(duration) // FFmpeg akan handle jika duration > original
        .audioCodec("libmp3lame")
        .audioBitrate("128k")
        .audioChannels(2)
        .audioFrequency(44100)
        .output(outputPath)
        .on("start", (cmd) => {
          console.log("Trim command:", cmd);
        })
        .on("end", () => {
          console.log(`Trim completed: ${path.basename(outputPath)}`);
          resolve();
        })
        .on("error", (err) => {
          console.error("Trim error:", err);
          reject(err);
        })
        .run();
    }
  });
}

// Fungsi untuk loop audio - DIPERBAIKI dengan pendekatan yang lebih stabil
function loopAudio(inputPath, outputPath, targetDuration) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log(
        `Looping audio: ${path.basename(inputPath)} to ${targetDuration}s`
      );

      const originalDuration = await getAudioDuration(inputPath);
      const loopCount = Math.ceil(targetDuration / originalDuration);

      console.log(
        `Original duration: ${originalDuration}s, Loop count: ${loopCount}`
      );

      if (loopCount <= 1) {
        await trimAudio(inputPath, outputPath, targetDuration);
        resolve();
        return;
      }

      // Gunakan multiple input dan concat filter
      let command = ffmpeg();
      for (let i = 0; i < loopCount; i++) {
        command = command.input(inputPath);
      }

      command
        .on("start", (cmd) => {
          console.log("Loop command:", cmd);
        })
        .complexFilter([
          {
            filter: "concat",
            options: {
              n: loopCount,
              v: 0,
              a: 1,
            },
          },
        ])
        .outputOptions([
          "-avoid_negative_ts",
          "make_zero",
          "-ac",
          "2",
          "-ar",
          "44100",
          "-b:a",
          "128k",
        ])
        .audioCodec("aac")
        .format("mp4") // atau "m4a", tergantung output yang kamu mau
        .output(outputPath)
        .on("end", async () => {
          console.log(`Loop completed: ${path.basename(outputPath)}`);

          // Trim agar durasinya pas
          await trimAudio(outputPath, outputPath, targetDuration);
          resolve();
        })
        .on("error", (err) => {
          console.error("Loop error:", err);
          reject(err);
        })
        .run();
    } catch (error) {
      console.error("Loop preparation error:", error);
      reject(error);
    }
  });
}

// Fungsi untuk mixing voice dengan backsound - DIPERBAIKI TOTAL
function mixVoiceWithBacksound(
  voicePath,
  backsoundPath,
  outputPath,
  voiceDuration
) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log("=== MIXING AUDIO ===");
      console.log(`Voice: ${voicePath}, Duration: ${voiceDuration}s`);
      console.log(`Backsound: ${backsoundPath}`);

      // Validasi file dengan ffprobe
      await validateMediaFile(voicePath, "audio");
      await validateMediaFile(backsoundPath, "audio");

      const backsoundDuration = await getAudioDuration(backsoundPath);
      console.log(`Backsound duration: ${backsoundDuration}s`);

      const processedBacksound = path.join(
        path.dirname(outputPath),
        `processed_bg_${Date.now()}.mp3`
      );

      // Sesuaikan durasi backsound dengan voice
      console.log("Processing backsound duration...");
      if (backsoundDuration < voiceDuration) {
        console.log("Looping backsound...");
        await loopAudio(backsoundPath, processedBacksound, voiceDuration);
      } else if (backsoundDuration > voiceDuration) {
        console.log("Trimming backsound...");
        await trimAudio(backsoundPath, processedBacksound, voiceDuration);
      } else {
        // Durasi sama, copy saja
        console.log("Copying backsound...");
        fs.copyFileSync(backsoundPath, processedBacksound);
      }

      // Verifikasi processed backsound
      if (!fs.existsSync(processedBacksound)) {
        throw new Error("Failed to process backsound");
      }

      console.log("Mixing voice and backsound...");
      ffmpeg()
        .input(voicePath)
        .input(processedBacksound)
        .complexFilter([
          "[0:a]volume=1[a1]",
          "[1:a]volume=0.3[a2]",
          "[a1][a2]amix=inputs=2:duration=first:dropout_transition=0[aout]",
        ])
        .outputOptions([
          "-map",
          "[aout]",
          "-acodec",
          "libmp3lame",
          "-b:a",
          "128k",
          "-ac",
          "2",
          "-ar",
          "44100",
        ])
        .output(outputPath)
        .on("start", (cmd) => {
          console.log("Mix command:", cmd);
        })
        .on("progress", (progress) => {
          if (progress.percent) {
            console.log(`Mixing progress: ${Math.round(progress.percent)}%`);
          }
        })
        .on("end", () => {
          console.log("Mixing completed successfully");
          try {
            fs.unlinkSync(processedBacksound);
          } catch (e) {
            console.error("Cleanup error:", e);
          }
          resolve();
        })
        .on("error", (err) => {
          console.error("Mixing error:", err);
          try {
            fs.unlinkSync(processedBacksound);
          } catch (e) {}
          reject(err);
        })
        .run();
    } catch (error) {
      console.error("Mix preparation error:", error);
      reject(error);
    }
  });
}

// FUNGSI YANG DIPERBAIKI: Buat video 2K 60fps tanpa efek
function createVideoFromImage(imagePath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    duration = Math.max(1, Math.floor(duration || 5));

    console.log(
      `Creating 2K 60fps video: ${path.basename(imagePath)} - ${duration}s`
    );

    // Pastikan direktori output ada
    fs.ensureDirSync(path.dirname(outputPath));

    // Hapus file output jika sudah ada
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch (e) {}
    }

    // Verifikasi file gambar ada
    if (!fs.existsSync(imagePath)) {
      reject(new Error(`Image file not found: ${imagePath}`));
      return;
    }

    // Timeout untuk mencegah hanging
    const timeout = setTimeout(() => {
      console.log(`Timeout for ${path.basename(imagePath)}`);
      reject(new Error(`Video creation timeout for ${imagePath}`));
    }, 600000); // 10 menit timeout untuk 2K

    // Filter untuk 2K (2560x1440) dengan aspect ratio yang benar
    const videoFilter =
      "scale=2560:1440:force_original_aspect_ratio=decrease,pad=2560:1440:(ow-iw)/2:(oh-ih)/2:color=black";

    const command = ffmpeg(imagePath)
      .inputOptions(["-loop 1", "-t", duration.toString()])
      .outputOptions([
        "-vf",
        videoFilter,
        "-c:v libx264",
        "-pix_fmt yuv420p",
        "-r 60", // 60 fps
        "-preset medium", // Balance antara speed dan quality
        "-crf 20", // High quality untuk 2K
        "-profile:v high",
        "-level:v 4.2",
        "-an", // No audio
        "-movflags +faststart",
        "-y",
      ])
      .output(outputPath)
      .on("start", (cmd) => {
        console.log("FFmpeg command:", cmd);
      })
      .on("progress", (progress) => {
        if (progress.percent) {
          console.log(
            `Processing ${path.basename(imagePath)}: ${Math.round(
              progress.percent
            )}%`
          );
        }
      })
      .on("end", () => {
        clearTimeout(timeout);
        console.log(`2K 60fps video created: ${outputPath}`);
        resolve();
      })
      .on("error", (err) => {
        clearTimeout(timeout);
        console.error("FFmpeg error:", err);
        reject(err);
      });

    try {
      command.run();
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}

// Fungsi untuk menggabungkan video menggunakan file list method
function concatenateVideos(videoPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const videoCount = videoPaths.length;
    console.log(`Concatenating ${videoCount} videos...`);

    if (videoCount === 1) {
      fs.copySync(videoPaths[0], outputPath);
      resolve();
      return;
    }

    // Verifikasi semua file video ada
    for (const videoPath of videoPaths) {
      if (!fs.existsSync(videoPath)) {
        reject(new Error(`Video file not found: ${videoPath}`));
        return;
      }
    }

    // Buat file list untuk concat demuxer
    const listPath = path.join(path.dirname(outputPath), "filelist.txt");

    // Generate file list dengan path yang aman
    const fileList = videoPaths
      .map((videoPath) => {
        const safePath = path.resolve(videoPath).replace(/'/g, "\\'");
        return `file '${safePath}'`;
      })
      .join("\n");

    fs.writeFileSync(listPath, fileList);

    ffmpeg()
      .input(listPath)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions([
        "-c:v libx264",
        "-preset medium",
        "-crf 20", // High quality untuk 2K
        "-pix_fmt yuv420p",
        "-r 60", // Maintain 60fps
        "-profile:v high",
        "-level:v 4.2",
        "-movflags +faststart",
        "-y",
      ])
      .output(outputPath)
      .on("start", (cmd) => console.log("Concat command:", cmd))
      .on("progress", (progress) => {
        console.log(
          `Concatenation progress: ${Math.round(progress.percent || 0)}%`
        );
      })
      .on("end", () => {
        try {
          fs.unlinkSync(listPath);
        } catch (e) {}
        console.log(
          `Successfully concatenated ${videoCount} videos in 2K 60fps`
        );
        resolve();
      })
      .on("error", (err) => {
        try {
          fs.unlinkSync(listPath);
        } catch (e) {}
        console.error("Concatenation error:", err);
        reject(err);
      })
      .run();
  });
}

// Fungsi untuk menambahkan audio ke video - DIPERBAIKI
function addAudioToVideo(
  videoPath,
  audioPath,
  outputPath,
  hasBacksound = false,
  backsoundPath = null
) {
  return new Promise(async (resolve, reject) => {
    try {
      console.log("=== ADDING AUDIO TO 2K 60fps VIDEO ===");
      console.log(`Video: ${videoPath}`);
      console.log(`Audio: ${audioPath}`);
      console.log(`Has backsound: ${hasBacksound}`);

      // Validasi file existence
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }
      if (!fs.existsSync(audioPath)) {
        throw new Error(`Audio file not found: ${audioPath}`);
      }

      let finalAudioPath = audioPath;

      if (hasBacksound && backsoundPath && fs.existsSync(backsoundPath)) {
        console.log("Mixing audio with backsound...");
        const voiceDuration = await getAudioDuration(audioPath);
        const mixedAudioPath = path.join(
          path.dirname(outputPath),
          `mixed_${Date.now()}.mp3`
        );

        await mixVoiceWithBacksound(
          audioPath,
          backsoundPath,
          mixedAudioPath,
          voiceDuration
        );
        finalAudioPath = mixedAudioPath;
      }

      console.log("Combining video and audio...");

      // Timeout untuk mencegah hanging
      const timeout = setTimeout(() => {
        console.log("Video-audio combination timeout");
        reject(new Error("Video-audio combination timeout"));
      }, 600000); // 5 menit timeout

      ffmpeg()
        .input(videoPath)
        .input(finalAudioPath)
        .outputOptions([
          "-c:v",
          "copy", // Copy video stream untuk maintain quality
          "-c:a",
          "aac",
          "-b:a",
          "128k", // Consistent bitrate
          "-ac",
          "2",
          "-ar",
          "44100",
          "-shortest", // Use shortest input duration
          "-movflags",
          "+faststart",
          "-avoid_negative_ts",
          "make_zero",
          "-y", // Overwrite output file
        ])
        .output(outputPath)
        .on("start", (cmd) => {
          console.log("Video-audio combine command:", cmd);
        })
        .on("progress", (progress) => {
          if (progress.percent) {
            console.log(
              `Video-audio progress: ${Math.round(progress.percent)}%`
            );
          }
        })
        .on("end", () => {
          clearTimeout(timeout);
          console.log("Video-audio combination completed");

          // Cleanup mixed audio if it was created
          if (finalAudioPath !== audioPath) {
            try {
              fs.unlinkSync(finalAudioPath);
            } catch (e) {
              console.error("Mixed audio cleanup error:", e);
            }
          }
          resolve();
        })
        .on("error", (err) => {
          clearTimeout(timeout);
          console.error("Video-audio combination error:", err);

          // Cleanup on error
          if (finalAudioPath !== audioPath) {
            try {
              fs.unlinkSync(finalAudioPath);
            } catch (e) {}
          }
          reject(err);
        })
        .run();
    } catch (error) {
      console.error("Add audio preparation error:", error);
      reject(error);
    }
  });
}

// Fungsi untuk download file dengan validasi
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const file = fs.createWriteStream(outputPath);

    client
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          file.close();
          // fs.unlinkSync(outputPath);
          downloadFile(response.headers.location, outputPath)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          // fs.unlinkSync(outputPath);
          reject(new Error(`Download failed: ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on("finish", () => {
          file.close();
          if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
            resolve();
          } else {
            reject(new Error("Downloaded file is empty"));
          }
        });

        file.on("error", (err) => {
          fs.unlink(outputPath, () => {});
          reject(err);
        });
      })
      .on("error", (err) => {
        try {
          file.close();
          fs.unlinkSync(outputPath);
        } catch (e) {}
        reject(err);
      });
  });
}

// Fungsi untuk parse durasi dari string durasi
function parseDurationFromText(durationText) {
  const match = durationText.match(/Image duration: (\d+) seconds/);
  return match ? parseInt(match[1]) : 5; // default 5 detik jika tidak ditemukan
}

// Endpoint utama - DIPERBAIKI untuk input format baru
app.post("/merge-image", async (req, res) => {
  const { imageUrls, audioUrl, durasi, Musicbacksound } = req.body;

  console.log("=== NEW REQUEST ===");
  console.log("Images:", imageUrls?.length || 0);
  console.log("Has backsound:", !!Musicbacksound);

  // Validasi input
  if (!imageUrls?.length || !audioUrl) {
    return res.status(400).json({ error: "imageUrls dan audioUrl diperlukan" });
  }

  const jobId = uuidv4();
  const jobTempDir = path.join(TEMP_DIR, jobId);
  fs.ensureDirSync(jobTempDir);

  try {
    // 1. Download dan analisis audio
    console.log("Downloading voice audio...");
    const voiceAudioPath = path.join(jobTempDir, "voice.mp3");
    await downloadFile(audioUrl.replace(/`/g, "").trim(), voiceAudioPath);

    const audioDuration = await getAudioDuration(voiceAudioPath);
    console.log(`Audio duration: ${audioDuration} seconds`);

    // 2. Parse durasi dari array durasi atau hitung otomatis
    let imageDurations = [];

    if (durasi && Array.isArray(durasi)) {
      // Parse durasi dari array durasi
      imageDurations = durasi.map((d) => parseDurationFromText(d));
      console.log("Parsed durations:", imageDurations);
    } else {
      // Hitung durasi otomatis jika tidak ada array durasi
      const imageCount = imageUrls.length;
      const baseDuration = Math.max(1, Math.floor(audioDuration / imageCount));
      const extraSeconds = Math.max(
        0,
        audioDuration - baseDuration * imageCount
      );

      imageDurations = Array(imageCount).fill(baseDuration);
      for (let i = 0; i < Math.floor(extraSeconds) && i < imageCount; i++) {
        imageDurations[i] += 1;
      }
      console.log("Calculated durations:", imageDurations);
    }

    // 3. Download backsound jika ada
    let backsoundPath = null;
    const hasBacksound =
      Musicbacksound &&
      typeof Musicbacksound === "string" &&
      Musicbacksound.trim().length > 0 &&
      !Musicbacksound.includes("undefined");

    if (hasBacksound) {
      console.log("Downloading backsound...");
      backsoundPath = path.join(jobTempDir, "backsound.mp3");
      await downloadFile(
        Musicbacksound.replace(/`/g, "").trim(),
        backsoundPath
      );
    }

    // 4. Proses setiap gambar menjadi video 2K 60fps
    const videoPaths = [];

    for (const [index, imageUrl] of imageUrls.entries()) {
      console.log(`Processing image ${index + 1}/${imageUrls.length}`);

      const imagePath = path.join(jobTempDir, `image_${index}.jpg`);
      const videoPath = path.join(jobTempDir, `video_${index}.mp4`);

      // Download gambar
      await downloadFile(imageUrl.replace(/`/g, "").trim(), imagePath);

      // Buat video 2K 60fps
      await createVideoFromImage(
        imagePath,
        videoPath,
        imageDurations[index] || 5
      );
      videoPaths.push(videoPath);
    }

    // 5. Gabungkan semua video
    console.log("Concatenating videos in 2K 60fps...");
    const mergedVideoPath = path.join(jobTempDir, "merged.mp4");
    await concatenateVideos(videoPaths, mergedVideoPath);

    // 6. Tambahkan audio ke video
    console.log("Adding audio to 2K 60fps video...");
    const finalVideoPath = path.join(jobTempDir, "final.mp4");
    await addAudioToVideo(
      mergedVideoPath,
      voiceAudioPath,
      finalVideoPath,
      hasBacksound,
      backsoundPath
    );

    // 7. Kirim hasil
    console.log("Sending final 2K 60fps video...");
    res.download(finalVideoPath, `video_2K_60fps_${jobId}.mp4`, (err) => {
      if (err) {
        console.error("Error sending file:", err);
      }

      // Cleanup
      setTimeout(() => {
        try {
          fs.removeSync(jobTempDir);
          console.log("Cleanup completed");
        } catch (e) {
          console.error("Cleanup error:", e);
        }
      }, 600000);
    });
  } catch (error) {
    console.error("Processing error:", error);
    res.status(500).json({
      error: "Pemrosesan gagal",
      detail: error.message,
    });

    // Cleanup on error
    try {
      fs.removeSync(jobTempDir);
    } catch (e) {
      console.error("Error cleanup:", e);
    }
  }
});

// End the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
