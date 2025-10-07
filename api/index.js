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
const { exec } = require("child_process");
const youtubedl = require('youtube-dl-exec');


const app = express();
const server = http.createServer(app);

ffmpeg.setFfmpegPath(ffmpegPath);

const io = new Server(server, {
  cors: {
    origin: "*", // You can restrict to your frontend URL
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Create downloads directory
const DOWNLOAD_DIR = './downloads';
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR);
}

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

app.post('/download', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log('Downloading audio from:', url);

    // Ensure the download directory exists
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }

    const outputTemplate = path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s');

    // Download audio only
    const result = await youtubedl(url, {
      extractAudio: true,
      audioFormat: 'mp3',
      output: outputTemplate,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addMetadata: true,
      ffmpegLocation: 'C:\\FFmpeg\\bin\\ffmpeg.exe'
    });

    // result should contain the filename in "output" or "file"
    const downloadedFile = typeof result === 'string' ? result : result._filename;
    const fileName = path.basename(downloadedFile).slice(0, path.basename(downloadedFile).length - 1);

    // Build the full URL (if serving via static route)
    const fileUrl = `http://192.168.1.45:4000/downloads/${encodeURIComponent(fileName)}`;

    console.log('fileUrl', fileUrl)

    res.json({
      success: true,
      message: 'Audio downloaded successfully',
      fileName,
      fileUrl // returning the full URL
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/download-audio', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    console.log('Downloading audio from:', url);

    const output = path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s');

    // Download best audio format without conversion
    const result = await youtubedl(url, {
      format: 'bestaudio/best',
      output: output,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true
    });

    res.json({
      success: true,
      message: 'Audio downloaded successfully (original format)',
      // output,
      // info: result
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/list-downloads', (req, res) => {
  try {
    const files = fs.readdirSync(DOWNLOAD_DIR).map(file => {
      const filePath = path.join(DOWNLOAD_DIR, file);
      const stats = fs.statSync(filePath);
      return {
        file: `http://192.168.1.45:4000/downloads/${encodeURIComponent(file)}`,
        fileName: file,
        size: stats.size,
        created: stats.birthtime
      };
    });

    res.json({
      success: true,
      count: files.length,
      files: files
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.use('/downloads', express.static(DOWNLOAD_DIR))

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {

    // console.log('file', file)
    const allowedExt = /mp3|wav|m4a|aac|ogg/;
    const extname = allowedExt.test(path.extname(file.originalname).toLowerCase());
    const mimeTypeAllowed = /audio/.test(file.mimetype); // just check if it's audio

    if (extname && mimeTypeAllowed) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed'));
    }
  }

});

// File upload endpoint
app.post('/upload', upload.single('audio'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    const fileUrl = `http://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({
      success: true,
      fileUrl: fileUrl,
      fileName: req.file.originalname,
      message: 'File uploaded successfully'
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// Rooms data
const rooms = new Map();

// Socket.io connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', (roomName) => {
    if (!rooms.has(roomName)) rooms.set(roomName, new Set());
    rooms.get(roomName).add(socket.id);
    socket.join(roomName);

    io.to(roomName).emit('room-users', Array.from(rooms.get(roomName)));
    console.log(`User ${socket.id} created and joined room: ${roomName}`);
  });

  socket.on('join-room', (roomName) => {
    if (!rooms.has(roomName)) rooms.set(roomName, new Set());
    rooms.get(roomName).add(socket.id);
    socket.join(roomName);

    io.to(roomName).emit('room-users', Array.from(rooms.get(roomName)));
    console.log(`User ${socket.id} joined room: ${roomName}`);
  });

  socket.on('leave-room', (roomName) => {
    if (rooms.has(roomName)) {
      rooms.get(roomName).delete(socket.id);
      socket.leave(roomName);
      io.to(roomName).emit('room-users', Array.from(rooms.get(roomName)));
      if (rooms.get(roomName).size === 0) rooms.delete(roomName);
    }
    console.log(`User ${socket.id} left room: ${roomName}`);
  });

  // Song controls
  socket.on('play-song', (data) => {
    console.log('Received play-song event:', data);
    console.log('Received room:', rooms);

    const { roomName, songUrl, fileName } = data;
    // console.log('roomName, songUrl, fileName', roomName, '===', songUrl, '===', fileName);

    io.to(roomName).emit('play-song', {
      url: songUrl,
      fileName: fileName
    });
    // socket.to(roomName).emit('play-song', {
    //   url: songUrl,
    //   fileName: fileName
    // });
  });

  socket.on('pause-song', ({ roomName }) => {
    io.to(roomName).emit('pause-song');
  });

  socket.on('resume-song', ({ roomName }) => {
    io.to(roomName).emit('resume-song');
  });

  socket.on('seek-song', ({ roomName, time }) => {
    io.to(roomName).emit('seek-song', time);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    rooms.forEach((users, roomName) => {
      if (users.has(socket.id)) {
        users.delete(socket.id);
        io.to(roomName).emit('room-users', Array.from(users));
        if (users.size === 0) rooms.delete(roomName);
      }
    });
  });
});


app.get('/', (req, res) => {
  res.send('Hello from Express on Vercel!');
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`Upload directory: ./uploads`);
});
