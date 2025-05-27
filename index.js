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

async function downloadFile(url, outputPath) {
  const writer = fs.createWriteStream(outputPath);
  const response = await axios({ url, method: "GET", responseType: "stream" });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function trimVideo(inputPath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setDuration(duration)
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}

function concatenateVideos(videoPaths, outputPath) {
  const listFile = path.join(TEMP_DIR, `concat_${uuidv4()}.txt`);
  const fileContent = videoPaths.map((p) => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, fileContent);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions("-c copy")
      .output(outputPath)
      .on("end", () => {
        fs.unlinkSync(listFile); // cleanup list file
        resolve();
      })
      .on("error", reject)
      .run();
  });
}

function addAudioToVideo(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions(["-c:v copy", "-c:a aac", "-shortest"])
      .output(outputPath)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
}
// Pastikan direktori temp ada dan memiliki izin tulis

// Tambahkan fungsi baru untuk membuat video dengan looping hingga mencapai durasi yang diinginkan
async function createLoopedVideo(inputPath, outputPath, requestedDuration) {
  // Dapatkan durasi asli video
  const videoDuration = await getVideoDuration(inputPath);

  // Jika durasi video sudah cukup, cukup trim saja
  if (videoDuration >= requestedDuration) {
    return trimVideo(inputPath, outputPath, requestedDuration);
  }

  // Buat file sementara untuk video yang diputar terbalik
  const reversedVideo = path.join(
    TEMP_DIR,
    `reversed_${path.basename(inputPath)}`
  );

  // Buat video terbalik menggunakan ffmpeg
  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-vf reverse", // Filter untuk membalikkan video
        "-af areverse", // Filter untuk membalikkan audio
      ])
      .output(reversedVideo)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  // Hitung berapa kali perlu melakukan looping ping-pong
  // Satu siklus ping-pong = durasi video asli + durasi video terbalik
  const pingPongDuration = videoDuration * 2;
  const loopCount = Math.ceil(requestedDuration / pingPongDuration);

  // Buat file list untuk concat
  const listFile = path.join(TEMP_DIR, `pingpong_${uuidv4()}.txt`);
  let fileContent = "";

  // Tambahkan pasangan video asli dan terbalik beberapa kali ke list
  for (let i = 0; i < loopCount; i++) {
    fileContent += `file '${inputPath}'\n`;
    fileContent += `file '${reversedVideo}'\n`;
  }

  fs.writeFileSync(listFile, fileContent);

  // Gabungkan video dalam pola ping-pong
  const loopedVideo = path.join(
    TEMP_DIR,
    `looped_${path.basename(outputPath)}`
  );

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(listFile)
      .inputOptions(["-f concat", "-safe 0"])
      .outputOptions("-c copy")
      .output(loopedVideo)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  // Trim hasil looping ke durasi yang tepat
  await trimVideo(loopedVideo, outputPath, requestedDuration);

  // Bersihkan file sementara
  fs.unlinkSync(listFile);
  fs.unlinkSync(loopedVideo);
  fs.unlinkSync(reversedVideo);
}

// Fungsi untuk mendapatkan durasi video
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

// Cara 1: Menggunakan regex langsung pada string
function extractDurationsFromString(str) {
  const regex = /Image duration: (\d+) seconds/g;
  const durations = [];
  let match;

  while ((match = regex.exec(str)) !== null) {
    durations.push(parseInt(match[1]));
  }

  return durations;
}

// Cara 2: Mencoba parse string menjadi array terlebih dahulu
function extractDurationsAlternative(inputStr) {
  try {
    // Coba parse string menjadi array
    const textArray = eval(inputStr); // Gunakan eval dengan hati-hati
    return extractDurations(textArray);
  } catch (e) {
    // Jika gagal parse, gunakan regex langsung
    return extractDurationsFromString(inputStr);
  }
}

// Fungsi untuk mengekstrak durasi dari teks
function extractDurations(textArray) {
  // Jika input adalah string, ubah menjadi array
  if (typeof textArray === "string") {
    try {
      // Coba parse jika string adalah representasi array
      textArray = JSON.parse(textArray);
    } catch (e) {
      // Jika gagal parse, buat array dengan satu elemen
      textArray = [textArray];
    }
  }

  // Array untuk menyimpan durasi
  const durations = [];

  // Loop melalui setiap teks
  textArray.forEach((text) => {
    // Cari pola "Image duration: X seconds"
    const match = text.match(/Image duration: (\d+) seconds/);
    if (match && match[1]) {
      // Tambahkan durasi ke array
      durations.push(parseInt(match[1]));
    }
  });

  return durations;
}

// Modifikasi endpoint /merge
app.post("/merge-create-video", async (req, res) => {
  const { imageUrl, audioUrl, durasi } = req.body;

  console.log(videos, durasi, audioUrl); // Log video and audioUrl for debugging purpose

  if (!videos || !audioUrl) {
    return res.status(400).json({ error: "videos and audioUrl are required" });
  }

  const jobId = uuidv4();
  const videoOutputPaths = [];

  try {
    // Download and process all video segments
    for (const [index, video] of videos.entries()) {
      const tempVideo = path.join(TEMP_DIR, `${jobId}_video_${index}.mp4`);
      const processedVideo = path.join(
        TEMP_DIR,
        `${jobId}_video_processed_${index}.mp4`
      );

      await downloadFile(video.url, tempVideo);

      // Gunakan fungsi looping baru alih-alih trimVideo
      await createLoopedVideo(tempVideo, processedVideo, video.duration);

      videoOutputPaths.push(processedVideo);
    }

    // Concatenate videos
    const mergedVideo = path.join(TEMP_DIR, `${jobId}_merged.mp4`);
    await concatenateVideos(videoOutputPaths, mergedVideo);

    // Download audio
    const audioPath = path.join(TEMP_DIR, `${jobId}_audio.mp3`);
    await downloadFile(audioUrl, audioPath);

    // Merge with audio
    const finalOutput = path.join(TEMP_DIR, `${jobId}_final.mp4`);
    await addAudioToVideo(mergedVideo, audioPath, finalOutput);

    res.download(finalOutput, "final_video.mp4", () => {
      fs.removeSync(TEMP_DIR); // Cleanup after download
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Processing failed", detail: err.message });
  }
});

// Fungsi untuk mengkonversi gambar menjadi video dengan efek sederhana
async function createVideoFromImage(imagePath, outputPath, duration, effect) {
  return new Promise((resolve, reject) => {
    // Bersihkan path output untuk menghindari masalah karakter khusus
    const safeOutputPath = outputPath.replace(/[\\/:*?"<>|]/g, "_");

    // Pastikan direktori temp ada
    const outputDir = path.dirname(outputPath);
    fs.ensureDirSync(outputDir, { mode: 0o777 }); // Izin penuh untuk direktori

    // Cek apakah file output sudah ada, jika ada hapus dulu
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch (err) {
        console.warn("Failed to delete existing output file:", err);
      }
    }

    // Tentukan filter berdasarkan efek yang dipilih
    let vfFilter = "scale=1920:1080";

    // Hitung total frame berdasarkan durasi (60 fps untuk pergerakan sangat halus)
    const totalFrames = Math.round(duration * 60);

    // Terapkan efek yang sesuai dengan pergerakan yang lebih halus
    if (effect) {
      switch (effect) {
        case "zoom-out":
          // Zoom out perlahan dari 1.3 ke 1.0 sepanjang durasi video dengan kurva halus
          vfFilter = `zoompan=z='1.3-(0.3*on/${totalFrames})':d=${totalFrames}:s=1920x1080:fps=60`;
          break;
        case "pan-left":
          // Pan dari kanan ke kiri perlahan sepanjang durasi video
          vfFilter = `zoompan=z=1.1:x='iw-(iw*on/${totalFrames}*0.3)':d=${totalFrames}:s=1920x1080:fps=60`;
          break;
        case "pan-right":
          // Pan dari kiri ke kanan perlahan sepanjang durasi video
          vfFilter = `zoompan=z=1.1:x='0+(iw*on/${totalFrames}*0.3)':d=${totalFrames}:s=1920x1080:fps=60`;
          break;
        case "shift-up":
          // Shift dari bawah ke atas perlahan sepanjang durasi video
          vfFilter = `zoompan=z=1.1:y='ih-(ih*on/${totalFrames}*0.3)':d=${totalFrames}:s=1920x1080:fps=60`;
          break;
        case "shift-down":
          // Shift dari atas ke bawah perlahan sepanjang durasi video
          vfFilter = `zoompan=z=1.1:y='0+(ih*on/${totalFrames}*0.3)':d=${totalFrames}:s=1920x1080:fps=60`;
          break;
        default:
          // Gunakan scale default jika efek tidak dikenali
          break;
      }
    }

    // Gunakan filter dengan efek yang dipilih
    ffmpeg(imagePath)
      .inputOptions(["-loop 1"])
      .outputOptions([
        "-vf",
        vfFilter,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-t",
        duration.toString(),
        "-preset",
        "slow", // Menggunakan preset "slow" untuk kualitas lebih baik
        "-crf",
        "18", // CRF rendah (18) untuk kualitas tinggi
        "-tune",
        "stillimage",
        "-r", // Tambahkan parameter frame rate output
        "60", // Set output frame rate ke 60fps
        "-y", // Paksa overwrite
      ])
      .output(outputPath)
      .on("start", (commandLine) => {
        console.log("FFmpeg command:", commandLine);
      })
      .on("end", resolve)
      .on("error", (err) => {
        console.error("FFmpeg error:", err);

        // Jika masih error, coba dengan opsi yang lebih sederhana
        console.log("Trying with minimal options...");

        // Gunakan scale default untuk fallback
        ffmpeg(imagePath)
          .inputOptions(["-loop 1"])
          .outputOptions([
            "-vf",
            "scale=1920:1080", // Tetap gunakan resolusi 1080p
            "-c:v",
            "libx264",
            "-crf",
            "20", // Ditambahkan parameter CRF untuk kualitas lebih baik
            "-t",
            duration.toString(),
            "-r", // Tambahkan parameter frame rate output
            "60", // Set output frame rate ke 60fps
            "-y",
          ])
          .output(outputPath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      })
      .run();
  });
}

// Fungsi untuk mendapatkan efek kamera secara acak
function getRandomEffect() {
  const effects = [
    "zoom-out",
    "pan-left",
    "pan-right",
    "shift-up",
    "shift-down",
  ];

  return effects[Math.floor(Math.random() * effects.length)];
}

// Fungsi untuk mengkonversi format durasi "1:26" menjadi detik
function convertDurationToSeconds(duration) {
  if (!duration) return 0;

  // Jika sudah dalam bentuk detik (angka)
  if (!isNaN(duration)) return parseInt(duration);

  // Jika dalam format "1:26"
  const parts = duration.split(":");
  if (parts.length === 2) {
    const minutes = parseInt(parts[0]);
    const seconds = parseInt(parts[1]);
    return minutes * 60 + seconds;
  }

  // Jika dalam format "1:30:45" (jam:menit:detik)
  if (parts.length === 3) {
    const hours = parseInt(parts[0]);
    const minutes = parseInt(parts[1]);
    const seconds = parseInt(parts[2]);
    return hours * 3600 + minutes * 60 + seconds;
  }

  return 0;
}

// Endpoint untuk merge-image
app.post("/merge-image", async (req, res) => {
  const { imageUrls, audioUrl, durasi, durasiMusic } = req.body;
  // Hapus 'effects' dari destructuring karena kita akan selalu menggunakan efek acak

  // Hapus definisi lokal TEMP_DIR karena sudah didefinisikan secara global
  // const TEMP_DIR = path.join(__dirname, "temp");
  // fs.ensureDirSync(TEMP_DIR, { mode: 0o755 });

  // Bersihkan direktori temp sebelum memulai proses baru
  try {
    fs.emptyDirSync(TEMP_DIR);
  } catch (err) {
    console.error("Error cleaning temp directory:", err);
  }

  if (!imageUrls || !audioUrl || !imageUrls.length) {
    return res.status(400).json({ error: "imageUrls dan audioUrl diperlukan" });
  }

  // Konversi durasi musik ke detik
  const totalDurationInSeconds = convertDurationToSeconds(durasiMusic);

  // Hitung durasi yang adil untuk setiap gambar
  const fairDurationPerImage = Math.floor(
    totalDurationInSeconds / imageUrls.length
  );

  // Buat array durasi yang adil untuk setiap gambar
  const imageDurations = Array(imageUrls.length).fill(fairDurationPerImage);

  // Distribusikan sisa detik (jika ada) ke gambar-gambar awal
  const remainingSeconds =
    totalDurationInSeconds - fairDurationPerImage * imageUrls.length;
  for (let i = 0; i < remainingSeconds; i++) {
    imageDurations[i % imageUrls.length]++;
  }

  // Buat array efek acak untuk setiap gambar
  const imageEffects = [];
  for (let i = 0; i < imageUrls.length; i++) {
    imageEffects.push(getRandomEffect());
  }

  const jobId = uuidv4();
  const videoOutputPaths = [];

  try {
    // Download dan proses semua gambar
    for (const [index, imageUrl] of imageUrls.entries()) {
      // Bersihkan URL dari backticks jika ada
      const cleanImageUrl = imageUrl.replace(/`/g, "").trim();

      const tempImage = path.join(TEMP_DIR, `${jobId}_image_${index}.jpg`);
      const processedVideo = path.join(TEMP_DIR, `${jobId}_video_${index}.mp4`);

      try {
        // Download gambar
        await downloadFile(cleanImageUrl, tempImage);

        // Verifikasi file gambar ada
        if (!fs.existsSync(tempImage)) {
          throw new Error(`File gambar tidak berhasil diunduh: ${tempImage}`);
        }

        // Konversi gambar menjadi video dengan efek kamera acak
        await createVideoFromImage(
          tempImage,
          processedVideo,
          imageDurations[index],
          imageEffects[index]
        );

        videoOutputPaths.push(processedVideo);
      } catch (err) {
        console.error(`Error processing image ${index}:`, err);
        throw err; // Re-throw untuk ditangkap di catch utama
      }
    }

    // Gabungkan semua video
    const mergedVideo = path.join(TEMP_DIR, `${jobId}_merged.mp4`);
    await concatenateVideos(videoOutputPaths, mergedVideo);

    // Download audio (bersihkan URL dari backticks jika ada)
    const cleanAudioUrl = audioUrl.replace(/`/g, "").trim();
    const audioPath = path.join(TEMP_DIR, `${jobId}_audio.mp3`);
    await downloadFile(cleanAudioUrl, audioPath);

    // Gabungkan video dengan audio
    const finalOutput = path.join(TEMP_DIR, `${jobId}_final.mp4`);
    await addAudioToVideo(mergedVideo, audioPath, finalOutput);

    // Perbaikan untuk memastikan video dapat diputar dengan benar
    const optimizedOutput = path.join(TEMP_DIR, `${jobId}_optimized.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg(finalOutput)
        .outputOptions([
          "-movflags faststart", // Optimasi untuk streaming
          "-pix_fmt yuv420p", // Format pixel yang kompatibel
          "-c:v libx264", // Codec video
          "-c:a aac", // Codec audio
        ])
        .output(optimizedOutput)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    // Kirim file hasil sebagai respons
    res.download(optimizedOutput, "final_video.mp4", () => {
      // Bersihkan file sementara setelah download selesai
      fs.removeSync(TEMP_DIR);
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Pemrosesan gagal", detail: err.message });
    // Bersihkan file sementara jika terjadi error
    try {
      fs.removeSync(TEMP_DIR);
    } catch (cleanupErr) {
      console.error("Error cleaning up temp directory:", cleanupErr);
    }
  }
});

// End the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
