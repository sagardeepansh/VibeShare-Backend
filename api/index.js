const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require("fs");
const yts = require("yt-search");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const youtubedl = require('youtube-dl-exec');

const app = express();
const server = http.createServer(app);

// Set ffmpeg path (auto handles static binary)
ffmpeg.setFfmpegPath(ffmpegPath);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// ✅ Use writable /tmp directory (serverless safe)
const uploadDir = path.join('/tmp', 'uploads');
const DOWNLOAD_DIR = path.join('/tmp', 'downloads');

// Create temporary directories if not exist
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// Serve static files from /tmp directories
app.use('/uploads', express.static(uploadDir));
app.use('/downloads', express.static(DOWNLOAD_DIR));

// 🧠 YouTube Search API
app.get("/search", async (req, res) => {
  try {
    const query = req.query.query;
    if (!query) return res.status(400).json({ error: "Missing search query" });

    const result = await yts(query);
    const videos = result.videos.slice(0, 7).map(v => ({
      thumbnail: v?.thumbnail,
      title: v.title,
      url: v.url,
      duration: v.timestamp,
      views: v.views,
      author: v.author.name
    }));

    res.json({ results: videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🎵 Download YouTube audio (mp3)
app.post('/download', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    console.log('Downloading audio from:', url);

    const outputTemplate = path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s');

    const result = await youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: outputTemplate,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addMetadata: true,
      ffmpegLocation: ffmpegPath // ✅ Correct static ffmpeg
    });

    const downloadedFile = typeof result === 'string' ? result : result._filename;
    const fileName = path.basename(downloadedFile);
    const fileUrl = `${req.protocol}://${req.get('host')}/downloads/${encodeURIComponent(fileName)}`;

    res.json({
      success: true,
      message: 'Audio downloaded successfully',
      fileName,
      fileUrl
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 🎧 File upload via multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    const allowedExt = /mp3|wav|m4a|aac|ogg/;
    const extname = allowedExt.test(path.extname(file.originalname).toLowerCase());
    const mimeTypeAllowed = /audio/.test(file.mimetype);
    if (extname && mimeTypeAllowed) cb(null, true);
    else cb(new Error('Only audio files are allowed'));
  }
});

// 📤 Upload endpoint
app.post('/upload', upload.single('audio'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({
      success: true,
      fileUrl,
      fileName: req.file.originalname,
      message: 'File uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// 📂 List downloaded files
app.get('/list-downloads', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR).map(file => {
      const filePath = path.join(DOWNLOAD_DIR, file);
      const stats = fs.statSync(filePath);
      return {
        file: `${req.protocol}://${req.get('host')}/downloads/${encodeURIComponent(file)}`,
        fileName: file,
        size: stats.size,
        created: stats.birthtime
      };
    });

    res.json({
      success: true,
      count: files.length,
      files
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 🎵 Socket.io (music sync)
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', (roomName) => {
    if (!rooms.has(roomName)) rooms.set(roomName, new Set());
    rooms.get(roomName).add(socket.id);
    socket.join(roomName);
    io.to(roomName).emit('room-users', Array.from(rooms.get(roomName)));
    console.log(`User ${socket.id} created/joined room: ${roomName}`);
  });

  socket.on('join-room', (roomName) => {
    if (!rooms.has(roomName)) rooms.set(roomName, new Set());
    rooms.get(roomName).add(socket.id);
    socket.join(roomName);
    io.to(roomName).emit('room-users', Array.from(rooms.get(roomName)));
  });

  socket.on('leave-room', (roomName) => {
    if (rooms.has(roomName)) {
      rooms.get(roomName).delete(socket.id);
      socket.leave(roomName);
      io.to(roomName).emit('room-users', Array.from(rooms.get(roomName)));
      if (rooms.get(roomName).size === 0) rooms.delete(roomName);
    }
  });

  socket.on('play-song', (data) => {
    const { roomName, songUrl, fileName } = data;
    io.to(roomName).emit('play-song', { url: songUrl, fileName });
  });

  socket.on('pause-song', ({ roomName }) => io.to(roomName).emit('pause-song'));
  socket.on('resume-song', ({ roomName }) => io.to(roomName).emit('resume-song'));
  socket.on('seek-song', ({ roomName, time }) => io.to(roomName).emit('seek-song', time));

  socket.on('disconnect', () => {
    rooms.forEach((users, roomName) => {
      if (users.has(socket.id)) {
        users.delete(socket.id);
        io.to(roomName).emit('room-users', Array.from(users));
        if (users.size === 0) rooms.delete(roomName);
      }
    });
  });
});

// 🏠 Root route
app.get('/', (req, res) => {
  res.send('✅ Express + Socket.IO server running on Vercel (using /tmp storage)');
});

// ✅ Start Server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`Temporary upload dir: ${uploadDir}`);
});
