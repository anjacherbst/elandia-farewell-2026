const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(SUBMISSIONS_FILE)) fs.writeFileSync(SUBMISSIONS_FILE, '[]', 'utf8');

function safeWriteJson(filePath, data) {
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function getSubmissions() {
  try {
    const raw = fs.readFileSync(SUBMISSIONS_FILE, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('Error reading submissions:', err);
    return [];
  }
}

function saveSubmissions(list) {
  safeWriteJson(SUBMISSIONS_FILE, list);
}

function getRoster() {
  try {
    const raw = fs.readFileSync(ROSTER_FILE, 'utf8');
    return JSON.parse(raw || '{"classes":[],"students":[]}');
  } catch (err) {
    console.error('Error reading roster:', err);
    return { classes: [], students: [] };
  }
}

function saveRoster(data) {
  safeWriteJson(ROSTER_FILE, data);
}

function getSubmissionById(id) {
  const subs = getSubmissions();
  return subs.find(s => s.id === id);
}

function normalize(str) {
  return (str || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function findSubmission(firstName, surname, className) {
  const subs = getSubmissions();
  const nFirst = normalize(firstName);
  const nLast = normalize(surname);
  const nClass = normalize(className);

  return subs.find(s => 
    normalize(s.learnerFirstName) === nFirst &&
    normalize(s.learnerSurname) === nLast &&
    normalize(s.className) === nClass
  );
}

function sanitizeForFilename(str) {
  return (str || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_');
}

function addOrUpdateSubmission(subData, uploadedFile, replaceExisting = false) {
  const subs = getSubmissions();
  const existing = findSubmission(subData.learnerFirstName, subData.learnerSurname, subData.className);

  const cleanSurname = sanitizeForFilename(subData.learnerSurname);
  const cleanFirst = sanitizeForFilename(subData.learnerFirstName);
  const cleanClass = sanitizeForFilename(subData.className);
  const ext = path.extname(uploadedFile.originalname).toLowerCase() || '.jpg';
  
  // Format: [Class]_[Surname]_[FirstName]_[Timestamp].[ext]
  const targetFilename = `${cleanClass}_${cleanSurname}_${cleanFirst}_${Date.now()}${ext}`;
  const targetPath = path.join(UPLOADS_DIR, targetFilename);

  // Move uploaded file to target filename
  fs.renameSync(uploadedFile.path, targetPath);

  const now = new Date();
  const formattedDate = new Intl.DateTimeFormat('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Africa/Johannesburg'
  }).format(now);

  const record = {
    id: existing ? existing.id : 'sub_' + Math.random().toString(36).substring(2, 9),
    parentName: subData.parentName.trim(),
    parentContact: (subData.parentContact || '').trim(),
    learnerFirstName: subData.learnerFirstName.trim(),
    learnerSurname: subData.learnerSurname.trim(),
    learnerFullName: `${subData.learnerFirstName.trim()} ${subData.learnerSurname.trim()}`,
    className: subData.className.trim(),
    filename: targetFilename,
    originalFilename: uploadedFile.originalname,
    fileSize: uploadedFile.size,
    mimetype: uploadedFile.mimetype,
    consent: Boolean(subData.consent),
    submittedAt: now.toISOString(),
    formattedDate: formattedDate,
    updatedAt: now.toISOString(),
    isUpdated: !!existing
  };

  if (existing) {
    // Delete previous physical file if it exists
    if (existing.filename && existing.filename !== targetFilename) {
      const oldPath = path.join(UPLOADS_DIR, existing.filename);
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (e) { console.warn('Could not remove old file:', e); }
      }
    }
    const idx = subs.findIndex(s => s.id === existing.id);
    subs[idx] = record;
  } else {
    subs.unshift(record);
  }

  saveSubmissions(subs);
  return record;
}

function deleteSubmission(id) {
  const subs = getSubmissions();
  const target = subs.find(s => s.id === id);
  if (!target) return false;

  if (target.filename) {
    const filePath = path.join(UPLOADS_DIR, target.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { console.warn('Could not remove file:', e); }
    }
  }

  const filtered = subs.filter(s => s.id !== id);
  saveSubmissions(filtered);
  return true;
}

function getRosterComparison() {
  const subs = getSubmissions();
  const roster = getRoster();

  const submittedMap = new Map();
  for (const s of subs) {
    const key = `${normalize(s.className)}|${normalize(s.learnerSurname)}|${normalize(s.learnerFirstName)}`;
    submittedMap.set(key, s);
  }

  const comparison = roster.students.map(st => {
    const key = `${normalize(st.className)}|${normalize(st.surname)}|${normalize(st.firstName)}`;
    const submission = submittedMap.get(key) || null;
    return {
      rosterId: st.id,
      firstName: st.firstName,
      surname: st.surname,
      fullName: `${st.firstName} ${st.surname}`,
      className: st.className,
      hasSubmitted: !!submission,
      submission: submission
    };
  });

  // Also include any submissions that were submitted by parents whose names aren't on roster
  const extraSubmissions = subs.filter(s => {
    const key = `${normalize(s.className)}|${normalize(s.learnerSurname)}|${normalize(s.learnerFirstName)}`;
    return !roster.students.some(st => `${normalize(st.className)}|${normalize(st.surname)}|${normalize(st.firstName)}` === key);
  });

  return {
    rosterComparison: comparison,
    extraSubmissions: extraSubmissions,
    totalExpected: roster.students.length + extraSubmissions.length,
    totalSubmitted: subs.length,
    totalMissing: roster.students.filter(st => {
      const key = `${normalize(st.className)}|${normalize(st.surname)}|${normalize(st.firstName)}`;
      return !submittedMap.has(key);
    }).length
  };
}

module.exports = {
  UPLOADS_DIR,
  getSubmissions,
  saveSubmissions,
  getRoster,
  saveRoster,
  getSubmissionById,
  findSubmission,
  addOrUpdateSubmission,
  deleteSubmission,
  getRosterComparison,
  normalize
};
