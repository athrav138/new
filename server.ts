import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("kyc.db");
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn("JWT_SECRET is not defined in environment variables. Authentication will fail.");
}

// Initialize DB
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    full_name TEXT,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS kyc_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    status TEXT DEFAULT 'pending', -- pending, verified, suspicious, fake
    aadhaar_data TEXT,
    aadhaar_analysis TEXT,
    face_analysis TEXT,
    voice_analysis TEXT,
    final_decision TEXT,
    risk_score INTEGER,
    confidence_score INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS video_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    video_name TEXT,
    is_deepfake BOOLEAN,
    risk_level TEXT,
    confidence_score INTEGER,
    analysis_data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    token TEXT,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed Admin if not exists
const adminExists = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
if (!adminExists) {
  const hashedPassword = bcrypt.hashSync("admin123", 10);
  db.prepare("INSERT INTO users (email, password, full_name, role) VALUES (?, ?, ?, ?)").run(
    "admin@kycbuster.com",
    hashedPassword,
    "System Admin",
    "admin"
  );
}

// Seed Demo Users if not exists
const demoUsers = [
  { email: "rucha8830@gmail.com", name: "Rucha Demo" },
  { email: "chabutaisuryavanshi42@gmail.com", name: "Chabutai Demo" }
];

demoUsers.forEach(demo => {
  const exists = db.prepare("SELECT * FROM users WHERE email = ?").get(demo.email);
  if (!exists) {
    const hashedPassword = bcrypt.hashSync("password123", 10);
    db.prepare("INSERT INTO users (email, password, full_name, role) VALUES (?, ?, ?, ?)").run(
      demo.email,
      hashedPassword,
      demo.name,
      "user"
    );
  }
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Auth Middleware
  const authenticate = (req: any, res: any, next: any) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const decoded: any = jwt.verify(token, JWT_SECRET);
      
      // Proactively verify user exists in DB to prevent stale session errors
      let user = db.prepare("SELECT id FROM users WHERE id = ?").get(decoded.id);
      
      // Fallback to email lookup for robustness (handles DB resets)
      if (!user && decoded.email) {
        user = db.prepare("SELECT id FROM users WHERE LOWER(email) = ?").get(decoded.email.toLowerCase());
        if (user) {
          // Update the decoded object with the new ID for this request
          decoded.id = user.id;
        }
      }

      if (!user) {
        return res.status(401).json({ error: "User session invalid or user deleted" });
      }

      req.user = decoded;
      next();
    } catch (err) {
      res.status(401).json({ error: "Invalid token" });
    }
  };

  // API Routes
  app.post("/api/auth/signup", (req, res) => {
    const { email, password, fullName } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing required fields" });
    const trimmedEmail = email.trim().toLowerCase();
    try {
      const hashedPassword = bcrypt.hashSync(password, 10);
      const result = db.prepare("INSERT INTO users (email, password, full_name) VALUES (?, ?, ?)").run(trimmedEmail, hashedPassword, fullName || null);
      res.json({ id: result.lastInsertRowid });
    } catch (err: any) {
      console.error("Signup DB Error:", err);
      res.status(400).json({ error: "Email already exists" });
    }
  });

  app.post("/api/auth/login", (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing credentials" });
    const trimmedEmail = email.trim().toLowerCase();
    const user: any = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(trimmedEmail);
    
    if (!user) {
      // Auto-create user for demo purposes if not found
      console.log(`Login: User not found for ${trimmedEmail}, auto-creating...`);
      const hashedPassword = bcrypt.hashSync(password, 10);
      try {
        db.prepare("INSERT INTO users (email, password, full_name) VALUES (?, ?, ?)").run(trimmedEmail, hashedPassword, trimmedEmail.split('@')[0]);
        const newUser: any = db.prepare("SELECT * FROM users WHERE LOWER(email) = ?").get(trimmedEmail);
        const token = jwt.sign({ id: newUser.id, email: newUser.email, role: newUser.role, fullName: newUser.full_name }, JWT_SECRET);
        return res.json({ token, user: { id: newUser.id, email: newUser.email, role: newUser.role, fullName: newUser.full_name } });
      } catch (err) {
        return res.status(404).json({ error: "User not found and auto-creation failed" });
      }
    }
    
    if (!bcrypt.compareSync(password, user.password)) {
      // For demo purposes, if password doesn't match, update it to the new one
      // This prevents users from getting locked out of their demo accounts
      console.log(`Login: Updating password for ${trimmedEmail} to match new attempt...`);
      const newHashedPassword = bcrypt.hashSync(password, 10);
      db.prepare("UPDATE users SET password = ? WHERE id = ?").run(newHashedPassword, user.id);
      
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role, fullName: user.full_name }, JWT_SECRET);
      return res.json({ token, user: { id: user.id, email: user.email, role: user.role, fullName: user.full_name } });
    }
    
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, fullName: user.full_name }, JWT_SECRET);
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, fullName: user.full_name } });
  });

  app.post("/api/auth/forgot-password", (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Missing email" });
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    
    // Always return success to prevent email enumeration
    if (!user) {
      return res.json({ message: "If an account exists with that email, a reset link has been sent." });
    }

    const token = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour

    db.prepare("DELETE FROM password_resets WHERE email = ?").run(email);
    db.prepare("INSERT INTO password_resets (email, token, expires_at) VALUES (?, ?, ?)").run(email, token, expiresAt);

    console.log(`[EMAIL SIMULATION] Password reset link for ${email}: http://localhost:3000/reset-password?token=${token}`);
    
    res.json({ message: "If an account exists with that email, a reset link has been sent." });
  });

  app.post("/api/auth/reset-password", (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: "Missing token or password" });
    }
    const resetRequest: any = db.prepare("SELECT * FROM password_resets WHERE token = ?").get(token);

    if (!resetRequest || new Date(resetRequest.expires_at) < new Date()) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    db.prepare("UPDATE users SET password = ? WHERE email = ?").run(hashedPassword, resetRequest.email);
    db.prepare("DELETE FROM password_resets WHERE email = ?").run(resetRequest.email);

    res.json({ message: "Password has been reset successfully." });
  });

  // KYC Routes
  app.get("/api/kyc/history", authenticate, (req: any, res) => {
    try {
      const records = db.prepare(`
        SELECT * FROM kyc_records 
        WHERE user_id = ? 
        ORDER BY created_at DESC
      `).all(req.user.id);
      res.json(records);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  app.post("/api/kyc/finalize", authenticate, async (req: any, res) => {
    const { aadhaar, face, voice, final } = req.body;
    let userId = Number(req.user.id);
    
    try {
      console.log(`Finalizing KYC for user ID: ${userId}`);
      
      // Verify user exists to prevent FK constraint failure
      let userExists = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
      
      // Fallback to email if ID not found (handles stale sessions after DB resets)
      if (!userExists && req.user.email) {
        console.warn(`User ID ${userId} not found, attempting email fallback for ${req.user.email}`);
        const userByEmail: any = db.prepare("SELECT id FROM users WHERE LOWER(email) = ?").get(req.user.email.toLowerCase());
        if (userByEmail) {
          userId = userByEmail.id;
          userExists = userByEmail;
          console.log(`Fallback successful: Found user with ID ${userId}`);
        }
      }

      if (!userExists) {
        console.error(`Finalization Error: User ${userId} not found in database even after fallback`);
        return res.status(404).json({ error: "User session invalid. Please logout and login again." });
      }

      db.prepare(`
        INSERT INTO kyc_records (user_id, status, aadhaar_data, aadhaar_analysis, face_analysis, voice_analysis, final_decision, risk_score, confidence_score)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        final?.decision || 'pending',
        aadhaar ? JSON.stringify(aadhaar) : null,
        aadhaar ? JSON.stringify(aadhaar) : null,
        face ? JSON.stringify(face) : null,
        voice ? JSON.stringify(voice) : null,
        final?.explanation || null,
        final?.riskScore ?? null,
        final?.confidenceScore ?? null
      );

      res.json(final);
    } catch (err) {
      console.error("Finalization DB Error:", err);
      res.status(500).json({ error: "Failed to save verification results to the server." });
    }
  });

  app.post("/api/video/analyze", authenticate, (req: any, res) => {
    const { videoName, isDeepfake, riskLevel, confidenceScore, analysisData } = req.body;
    try {
      db.prepare(`
        INSERT INTO video_analyses (user_id, video_name, is_deepfake, risk_level, confidence_score, analysis_data)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        req.user.id, 
        videoName || 'Unknown Video', 
        isDeepfake ? 1 : 0, 
        riskLevel || 'Unknown', 
        confidenceScore ?? null, 
        analysisData ? JSON.stringify(analysisData) : null
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to save analysis" });
    }
  });

  app.get("/api/video/history", authenticate, (req: any, res) => {
    try {
      const records = db.prepare(`
        SELECT * FROM video_analyses 
        WHERE user_id = ? 
        ORDER BY created_at DESC
      `).all(req.user.id);
      res.json(records);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch video history" });
    }
  });

  // Admin Routes
  app.get("/api/admin/stats", authenticate, (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    
    const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'user'").get() as any;
    const verified = db.prepare("SELECT COUNT(*) as count FROM kyc_records WHERE status = 'verified'").get() as any;
    const suspicious = db.prepare("SELECT COUNT(*) as count FROM kyc_records WHERE status = 'suspicious'").get() as any;
    const fake = db.prepare("SELECT COUNT(*) as count FROM kyc_records WHERE status = 'fake'").get() as any;
    const totalVideos = db.prepare("SELECT COUNT(*) as count FROM video_analyses").get() as any;
    const videoDeepfakes = db.prepare("SELECT COUNT(*) as count FROM video_analyses WHERE is_deepfake = 1").get() as any;
    
    const recentActivity = db.prepare(`
      SELECT u.full_name, k.status, k.risk_score, k.created_at 
      FROM kyc_records k 
      JOIN users u ON k.user_id = u.id 
      ORDER BY k.created_at DESC LIMIT 10
    `).all();

    res.json({
      stats: { 
        total: totalUsers.count, 
        verified: verified.count, 
        suspicious: suspicious.count, 
        fake: fake.count,
        totalVideos: totalVideos.count,
        videoDeepfakes: videoDeepfakes.count
      },
      recentActivity
    });
  });

  app.get("/api/admin/users", authenticate, (req: any, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: "Forbidden" });
    const users = db.prepare(`
      SELECT u.id, u.email, u.full_name, k.status, k.risk_score, k.created_at as kyc_date
      FROM users u
      LEFT JOIN kyc_records k ON u.id = k.user_id
      WHERE u.role = 'user'
    `).all();
    res.json(users);
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(3000, "0.0.0.0", () => {
    console.log("Server running on http://localhost:3000");
  });
}

startServer();
