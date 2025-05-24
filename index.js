import express from "express";
import path from "path";
import { GoogleGenAI, Modality } from "@google/genai";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import multer from "multer";
import fs from "fs"; // Add this import for file system operations

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

const upload = multer({ storage: storage });

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: "50mb" })); // Increased limit for larger JSON payloads
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.send("backend content");
});

app.post("/api/gemini", async (req, res) => {
  try {
    const { model, prompt } = req.body;
    console.log(model, prompt);
    const ai = new GoogleGenAI({
      apiKey: "AIzaSyAsJM4yX-VOCG0dczPcSy3xPuMV_savlSE",
    });

    const config = {
      responseModalities: ["TEXT", "IMAGE"],
    };
    const contents = [
      {
        role: "user",
        parts: [
          {
            text: prompt,
          },
        ],
      },
    ];

    // Set responseModalities to include "Image" so the model can generate  an image
    const response = await ai.models.generateContent({
      model: model,
      config,
      contents,
    });

    // res.status(200).json({ status: 200, data: response.candidates[0].content });
    res.status(200).json({ status: 200, data: response });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 500, data: error.message });
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

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
