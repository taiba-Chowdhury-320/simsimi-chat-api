const express = require("express");
const Database = require("better-sqlite3");
const { execSync } = require("child_process");
const fs = require("fs");

const app = express();
app.use(express.json());

const db = new Database("chat.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    senderId TEXT NOT NULL,
    question TEXT NOT NULL,
    response TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS teachings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    react TEXT DEFAULT '👍',
    createdAt TEXT DEFAULT (datetime('now'))
  );
`);

function findTaughtAnswer(query) {
  const rows = db.prepare("SELECT * FROM teachings").all();
  const q = query.toLowerCase().trim();
  for (const row of rows) {
    if (row.question.toLowerCase().trim() === q) return row;
  }
  for (const row of rows) {
    if (q.includes(row.question.toLowerCase().trim())) return row;
  }
  return null;
}

function exportAndGitPush() {
  try {
    const chats = db.prepare("SELECT * FROM chats ORDER BY id DESC LIMIT 500").all();
    const teachings = db.prepare("SELECT * FROM teachings ORDER BY id DESC").all();
    fs.writeFileSync("chat.json", JSON.stringify({ teachings, chats }, null, 2));

    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || "main";

    if (!token || !repo) {
      console.log("GITHUB_TOKEN or GITHUB_REPO not set.");
      return;
    }

    const remoteUrl = `https://${token}@github.com/${repo}.git`;
    execSync(`git config user.email "bot@simsimi.com"`);
    execSync(`git config user.name "Simsimi Bot"`);
    execSync(`git remote set-url origin ${remoteUrl} 2>/dev/null || git remote add origin ${remoteUrl}`);
    execSync(`git add chat.json`);
    execSync(`git commit -m "Auto update [${new Date().toISOString()}]" --allow-empty`);
    execSync(`git push origin ${branch} --force`);
    console.log("Git push done: " + new Date().toISOString());
  } catch (err) {
    console.error("Git push failed:", err.message);
  }
}

setInterval(exportAndGitPush, 15 * 60 * 1000);

app.get("/chat", async (req, res) => {
  const { q, senderId } = req.query;
  if (!q || !senderId) {
    return res.status(400).json({ success: false, error: "Missing q or senderId" });
  }
  try {
    const taught = findTaughtAnswer(q);
    if (taught) {
      db.prepare("INSERT INTO chats (senderId, question, response) VALUES (?, ?, ?)").run(senderId, q, taught.answer);
      return res.json({ success: true, response: taught.answer, react: taught.react, source: "taught", id: senderId });
    }

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: q }],
      }),
    });
    const data = await apiRes.json();
    if (!apiRes.ok) throw new Error(data?.error?.message || "API error");

    const aiResponse = data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    db.prepare("INSERT INTO chats (senderId, question, response) VALUES (?, ?, ?)").run(senderId, q, aiResponse);
    return res.json({ success: true, response: aiResponse, source: "ai", id: senderId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, id: senderId });
  }
});

app.get("/teach", (req, res) => {
  const { qsn, answer, react } = req.query;
  if (!qsn || !answer) {
    return res.status(400).json({ success: false, error: "Missing qsn or answer" });
  }
  const existing = db.prepare("SELECT * FROM teachings WHERE LOWER(question) = LOWER(?)").get(qsn);
  if (existing) {
    db.prepare("UPDATE teachings SET answer = ?, react = ? WHERE id = ?").run(answer, react || "👍", existing.id);
    return res.json({ success: true, message: "Updated", question: qsn, answer, react: react || "👍" });
  }
  db.prepare("INSERT INTO teachings (question, answer, react) VALUES (?, ?, ?)").run(qsn, answer, react || "👍");
  return res.json({ success: true, message: "Teaching saved", question: qsn, answer, react: react || "👍" });
});

app.get("/history", (req, res) => {
  const { senderId } = req.query;
  if (!senderId) return res.status(400).json({ success: false, error: "Missing senderId" });
  const rows = db.prepare("SELECT * FROM chats WHERE senderId = ? ORDER BY id DESC LIMIT 50").all(senderId);
  res.json({ success: true, id: senderId, history: rows });
});

app.get("/teachings", (req, res) => {
  const rows = db.prepare("SELECT * FROM teachings ORDER BY id DESC").all();
  res.json({ success: true, count: rows.length, teachings: rows });
});

app.get("/export", (req, res) => {
  exportAndGitPush();
  res.json({ success: true, message: "Git push triggered" });
});

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Simsimi Chat API running!",
    endpoints: {
      chat: "/chat?q=hello&senderId=uid123",
      teach: "/teach?qsn=hi&answer=Hello&react=😊",
      history: "/history?senderId=uid123",
      teachings: "/teachings",
      export: "/export",
    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Simsimi Chat API running on port " + PORT));
