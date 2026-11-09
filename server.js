const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const archiver = require('archiver');
const crypto = require('crypto');
require('dotenv').config();

const storage = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Elandia2026!Farewell';
const SESSION_SECRET = process.env.SESSION_SECRET || 'elandia-secret-jwt-key-2026';

// Keep active admin sessions in memory
const activeSessions = new Set();

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Multer storage for uploads
const uploadTempDir = path.join(__dirname, 'uploads_temp');
if (!fs.existsSync(uploadTempDir)) fs.mkdirSync(uploadTempDir, { recursive: true });

const upload = multer({
  dest: uploadTempDir,
  limits: {
    fileSize: 25 * 1024 * 1024 // 25 MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/pjpeg', 'image/x-png'];
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExts = ['.jpg', '.jpeg', '.png'];

    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, JPEG, and PNG images are supported.'));
    }
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Admin authentication middleware
function requireAdmin(req, res, next) {
  const token = req.cookies['elandia_admin_token'];
  if (token && activeSessions.has(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized. Please log in as administrator.' });
}

// Public API: Get Grade 7 Classes
app.get('/api/classes', (req, res) => {
  res.json({
    school: 'Laerskool Elandia',
    event: 'Grade 7 Farewell 2026',
    classes: ['7AV', '7LV', '7NC', '7TS', 'Grade 7 LSEN']
  });
});

// Public API: Check for duplicate submission
app.get('/api/check-duplicate', (req, res) => {
  const { firstName, surname, className } = req.query;
  if (!firstName || !surname || !className) {
    return res.json({ exists: false });
  }

  const existing = storage.findSubmission(firstName, surname, className);
  if (existing) {
    return res.json({
      exists: true,
      learnerFullName: existing.learnerFullName,
      className: existing.className,
      submittedAt: existing.submittedAt,
      formattedDate: existing.formattedDate,
      parentName: existing.parentName
    });
  }
  res.json({ exists: false });
});

// Public API: Submit Photo
app.post('/api/upload', (req, res) => {
  upload.single('photo')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'The uploaded file is too large. Maximum size is 25 MB.' });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Please choose or drag and drop a photograph before submitting.' });
    }

    const { parentName, learnerFirstName, learnerSurname, className, consent, replaceExisting } = req.body;

    if (!parentName || !parentName.trim()) {
      return res.status(400).json({ error: 'Parent/Guardian name and surname are required.' });
    }
    if (!learnerFirstName || !learnerFirstName.trim()) {
      return res.status(400).json({ error: 'Learner first name is required.' });
    }
    if (!learnerSurname || !learnerSurname.trim()) {
      return res.status(400).json({ error: 'Learner surname is required.' });
    }
    if (!className || !className.trim()) {
      return res.status(400).json({ error: 'Please select your child’s Grade 7 class.' });
    }
    if (!consent || consent === 'false') {
      return res.status(400).json({ error: 'Please confirm parental consent to include the photo in the farewell presentation.' });
    }

    const validClasses = ['7AV', '7LV', '7NC', '7TS', 'Grade 7 LSEN'];
    if (!validClasses.includes(className.trim())) {
      return res.status(400).json({ error: 'Invalid class selected. Choose from: ' + validClasses.join(', ') });
    }

    try {
      const record = storage.addOrUpdateSubmission({
        parentName,
        parentContact: req.body.parentContact,
        learnerFirstName,
        learnerSurname,
        className,
        consent: true
      }, req.file, replaceExisting === 'true');

      res.json({
        success: true,
        message: record.isUpdated ? 'Photograph updated successfully!' : 'Photograph uploaded successfully!',
        record: {
          id: record.id,
          learnerFullName: record.learnerFullName,
          className: record.className,
          parentName: record.parentName,
          filename: record.filename,
          formattedDate: record.formattedDate,
          isUpdated: record.isUpdated,
          photoUrl: `/api/view-photo/${record.id}`,
          downloadUrl: `/api/download-photo/${record.id}`
        }
      });
    } catch (saveErr) {
      console.error('Error saving submission:', saveErr);
      res.status(500).json({ error: 'An error occurred while saving the photograph. Please try again.' });
    }
  });
});

// View Photo by Submission ID (Mobile-friendly, no cookie blocking)
app.get('/api/view-photo/:id', (req, res) => {
  const sub = storage.getSubmissionById(req.params.id);
  if (!sub || !sub.filename) {
    return res.status(404).send('Photograph not found.');
  }

  const filePath = path.join(storage.UPLOADS_DIR, sub.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Photograph file is missing on storage.');
  }

  res.setHeader('Content-Type', sub.mimetype || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.sendFile(filePath);
});

// Download Photo by Submission ID (Works directly on mobile and desktop)
app.get('/api/download-photo/:id', (req, res) => {
  const sub = storage.getSubmissionById(req.params.id);
  if (!sub || !sub.filename) {
    return res.status(404).send('Photograph not found.');
  }

  const filePath = path.join(storage.UPLOADS_DIR, sub.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Photograph file is missing on storage.');
  }

  const ext = path.extname(sub.filename) || '.jpg';
  const cleanName = `${sub.className}_${sub.learnerSurname}_${sub.learnerFirstName}${ext}`.replace(/\s+/g, '_');
  res.download(filePath, cleanName);
});

// Admin Authentication API
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Incorrect administrator password.' });
  }

  const token = generateSessionToken();
  activeSessions.add(token);

  // Set secure cookie
  res.cookie('elandia_admin_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  });

  res.json({ success: true, message: 'Logged in successfully.' });
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.cookies['elandia_admin_token'];
  if (token) activeSessions.delete(token);
  res.clearCookie('elandia_admin_token');
  res.json({ success: true });
});

app.get('/api/admin/status', (req, res) => {
  const token = req.cookies['elandia_admin_token'];
  const authenticated = !!(token && activeSessions.has(token));
  res.json({ authenticated });
});

// Admin Submissions List
app.get('/api/admin/submissions', requireAdmin, (req, res) => {
  const subs = storage.getSubmissions();
  res.json({
    total: subs.length,
    submissions: subs
  });
});

// Admin Roster & Missing Students Comparison
app.get('/api/admin/roster-status', requireAdmin, (req, res) => {
  const comp = storage.getRosterComparison();
  res.json(comp);
});

// Admin Add/Edit Roster Student
app.post('/api/admin/roster', requireAdmin, (req, res) => {
  const { firstName, surname, className } = req.body;
  if (!firstName || !surname || !className) {
    return res.status(400).json({ error: 'First name, surname, and class are required.' });
  }

  const roster = storage.getRoster();
  const newStudent = {
    id: 'ros_' + Math.random().toString(36).substring(2, 8),
    firstName: firstName.trim(),
    surname: surname.trim(),
    className: className.trim()
  };

  roster.students.push(newStudent);
  storage.saveRoster(roster);

  res.json({ success: true, student: newStudent });
});

// Admin Delete Submission
app.delete('/api/admin/submissions/:id', requireAdmin, (req, res) => {
  const success = storage.deleteSubmission(req.params.id);
  if (success) {
    res.json({ success: true, message: 'Submission deleted.' });
  } else {
    res.status(404).json({ error: 'Submission not found.' });
  }
});

// View / Download Photo by Filename
app.get(['/api/admin/photo/:filename', '/api/photo/:filename'], (req, res) => {
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(storage.UPLOADS_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Photograph not found.');
  }

  const ext = path.extname(safeFilename).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png'
  };
  res.setHeader('Content-Type', mimeTypes[ext] || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.sendFile(filePath);
});

// Download single file as attachment with friendly name
app.get(['/api/admin/download/:id', '/api/download/:id'], (req, res) => {
  const subs = storage.getSubmissions();
  const sub = subs.find(s => s.id === req.params.id);
  if (!sub || !sub.filename) {
    return res.status(404).send('Photograph not found.');
  }

  const filePath = path.join(storage.UPLOADS_DIR, sub.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File missing from storage.');
  }

  const ext = path.extname(sub.filename) || '.jpg';
  const cleanDownloadName = `${sub.className}_${sub.learnerSurname}_${sub.learnerFirstName}${ext}`.replace(/\s+/g, '_');

  res.download(filePath, cleanDownloadName);
});

// Admin Bulk Download ALL Submissions as ZIP (Organized by Class)
app.get('/api/admin/download-zip', requireAdmin, (req, res) => {
  const subs = storage.getSubmissions();

  if (subs.length === 0) {
    return res.status(400).send('No photographs have been submitted yet.');
  }

  const zipFilename = `Laerskool_Elandia_Grade7_2026_Photos_${new Date().toISOString().slice(0, 10)}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.on('error', (err) => {
    console.error('Archive error:', err);
    res.status(500).send({ error: err.message });
  });

  archive.pipe(res);

  // Create CSV manifest
  let csvContent = '\uFEFF"Class","Learner Surname","Learner First Name","Parent/Guardian","Original Filename","Stored Filename","Submission Date","Consent"\r\n';

  for (const s of subs) {
    const ext = path.extname(s.filename) || '.jpg';
    const neatPhotoName = `${s.className}_${s.learnerSurname}_${s.learnerFirstName}${ext}`.replace(/\s+/g, '_');
    const folderPath = `${s.className}/${neatPhotoName}`;
    const filePath = path.join(storage.UPLOADS_DIR, s.filename);

    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: folderPath });
    }

    csvContent += `"${s.className}","${s.learnerSurname}","${s.learnerFirstName}","${s.parentName}","${s.originalFilename}","${folderPath}","${s.formattedDate}","Yes"\r\n`;
  }

  archive.append(csvContent, { name: 'Elandia_Grade7_2026_Submissions_Summary.csv' });
  archive.finalize();
});

// Admin Download Class-Specific ZIP
app.get('/api/admin/download-class-zip/:className', requireAdmin, (req, res) => {
  const targetClass = req.params.className;
  const subs = storage.getSubmissions().filter(s => s.className.toLowerCase() === targetClass.toLowerCase());

  if (subs.length === 0) {
    return res.status(400).send(`No photographs found for class ${targetClass}.`);
  }

  const zipFilename = `Elandia_Grade7_${targetClass.replace(/\s+/g, '_')}_Photos.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);

  for (const s of subs) {
    const ext = path.extname(s.filename) || '.jpg';
    const neatPhotoName = `${s.learnerSurname}_${s.learnerFirstName}${ext}`.replace(/\s+/g, '_');
    const filePath = path.join(storage.UPLOADS_DIR, s.filename);
    if (fs.existsSync(filePath)) {
      archive.file(filePath, { name: neatPhotoName });
    }
  }

  archive.finalize();
});

// Admin Export Missing Learners CSV
app.get('/api/admin/export-missing-csv', requireAdmin, (req, res) => {
  const comp = storage.getRosterComparison();
  const missing = comp.rosterComparison.filter(c => !c.hasSubmitted);

  let csv = '\uFEFF"Class","Learner Surname","Learner First Name","Photo Status"\r\n';
  missing.forEach(m => {
    csv += `"${m.className}","${m.surname}","${m.firstName}","MISSING / NOT YET SUBMITTED"\r\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="Elandia_Grade7_Missing_Photos_List.csv"');
  res.send(csv);
});

// Serve frontend routes
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`  LAERSKOOL ELANDIA - GRADE 7 CLASS OF 2026`);
    console.log(`  Photo Upload Web Application is running!`);
    console.log(`  Local URL:        http://localhost:${PORT}`);
    console.log(`  Admin Dashboard:  http://localhost:${PORT}/admin`);
    console.log(`  Admin Password:   ${ADMIN_PASSWORD}`);
    console.log(`====================================================`);
  });
}

module.exports = app;
