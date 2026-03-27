import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure Gmail Transporter
const gmailTransporter = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) 
  ? nodemailer.createTransport({
      service: "gmail",
      pool: true, // Use connection pooling
      maxConnections: 1, // Strictly one connection at a time
      maxMessages: 100, // Max messages per connection
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    })
  : null;

// Verify transporter on startup
if (gmailTransporter) {
  gmailTransporter.verify((error) => {
    if (error) {
      console.error("Gmail Transporter Verification Error:", error);
    } else {
      console.log("Gmail Transporter is ready to send emails");
    }
  });
}

// In-memory job store
const jobs: Record<string, {
  status: "pending" | "processing" | "completed" | "failed";
  results: { email: string; success: boolean; error?: string }[];
  total: number;
  processed: number;
  error?: string;
}> = {};

// Message Broker Implementation
interface EmailTask {
  jobId: string;
  to: string;
  subject: string;
  body: string;
  fromName: string;
  replyTo?: string;
  resume?: {
    originalname: string;
    buffer: Buffer;
  };
}

class MessageBroker {
  private queue: EmailTask[] = [];
  private isProcessing = false;
  private queueFilePath = path.join(process.cwd(), "email_queue.json");

  constructor() {
    this.loadQueue();
  }

  private loadQueue() {
    try {
      if (fs.existsSync(this.queueFilePath)) {
        const data = fs.readFileSync(this.queueFilePath, "utf8");
        const parsed = JSON.parse(data);
        // Convert base64 back to Buffer for resume attachments
        this.queue = parsed.map((task: any) => ({
          ...task,
          resume: task.resume ? {
            ...task.resume,
            buffer: Buffer.from(task.resume.buffer, "base64")
          } : undefined
        }));
        console.log(`Loaded ${this.queue.length} tasks from persistent queue.`);
        if (this.queue.length > 0) {
          this.process();
        }
      }
    } catch (err) {
      console.error("Failed to load queue from file:", err);
    }
  }

  private saveQueue() {
    try {
      // Convert Buffer to base64 for JSON serialization
      const dataToSave = this.queue.map(task => ({
        ...task,
        resume: task.resume ? {
          ...task.resume,
          buffer: task.resume.buffer.toString("base64")
        } : undefined
      }));
      fs.writeFileSync(this.queueFilePath, JSON.stringify(dataToSave, null, 2));
    } catch (err) {
      console.error("Failed to save queue to file:", err);
    }
  }

  push(task: EmailTask) {
    this.queue.push(task);
    this.saveQueue();
    this.process();
  }

  cancelJob(jobId: string) {
    this.queue = this.queue.filter(t => t.jobId !== jobId);
    this.saveQueue();
  }

  private async process() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue[0]; // Peek at the first task
      const job = jobs[task.jobId];

      // If job object is missing (e.g. server restarted), recreate a minimal one
      if (!job) {
        jobs[task.jobId] = {
          status: "processing",
          results: [],
          total: this.queue.filter(t => t.jobId === task.jobId).length,
          processed: 0
        };
      } else if ((job.status as string) === "failed") {
        this.queue.shift();
        this.saveQueue();
        continue;
      }

      const currentJob = jobs[task.jobId];
      currentJob.status = "processing";

      try {
        if (gmailTransporter) {
          await gmailTransporter.sendMail({
            from: `"${task.fromName || "Job Applicant"}" <${process.env.GMAIL_USER}>`,
            to: task.to,
            subject: task.subject,
            text: task.body,
            replyTo: task.replyTo || undefined,
            headers: {
              "X-JobApply-AI": "SentViaApp",
              "X-Category": "Job-Application"
            },
            attachments: task.resume ? [
              {
                filename: task.resume.originalname,
                content: task.resume.buffer,
              }
            ] : [],
          });
          currentJob.results.push({ email: task.to, success: true });
        } else {
          currentJob.results.push({ email: task.to, success: false, error: "Gmail service not configured." });
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`Broker failed to send to ${task.to}:`, err);
        currentJob.results.push({ email: task.to, success: false, error: errorMessage });

        if (errorMessage.includes("454-4.7.0") || errorMessage.includes("Too many login attempts")) {
          console.warn("Broker stopping job due to Gmail login throttling.");
          currentJob.status = "failed";
          currentJob.error = "Gmail throttling block detected.";
          this.cancelJob(task.jobId);
          continue; // cancelJob already shifts/filters and saves
        }
      } finally {
        // Remove the task we just processed
        this.queue.shift();
        this.saveQueue();

        currentJob.processed++;
        if (currentJob.processed >= currentJob.total && (currentJob.status as string) !== "failed") {
          currentJob.status = "completed";
        }
        
        // Respect Gmail throttling
        if (this.queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    this.isProcessing = false;
  }
}

const broker = new MessageBroker();

async function startServer() {
  console.log("Starting server...");
  const app = express();
  const PORT = process.env.PORT || 3000;

  // Configure multer for memory storage
  const storage = multer.memoryStorage();
  const upload = multer({ storage: storage });

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      gmailConfigured: !!gmailTransporter,
      gmailUser: process.env.GMAIL_USER || null
    });
  });

  // API Routes
  console.log("Registering /api/send-emails route...");

  app.get("/api/jobs/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  app.delete("/api/jobs/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    job.status = "failed";
    job.error = "Stopped by user";
    broker.cancelJob(jobId);
    res.json({ status: "ok" });
  });

  app.post("/api/send-emails", upload.single("resume"), async (req, res) => {
    console.log("Received request to /api/send-emails");
    try {
      const { emails, subject, body, fromName, replyTo } = req.body;
      const resume = req.file;

      if (!gmailTransporter) {
        return res.status(500).json({ 
          error: "No email service configured. Please add GMAIL_USER and GMAIL_APP_PASSWORD to your environment variables." 
        });
      }

      const emailList = emails.split(",").map((e: string) => e.trim()).filter(Boolean);

      if (emailList.length === 0) {
        return res.status(400).json({ error: "No valid email addresses provided" });
      }

      const jobId = Date.now().toString();
      jobs[jobId] = {
        status: "pending",
        results: [],
        total: emailList.length,
        processed: 0
      };

      const taggedBody = `${body}\n\n---\nSent via JobApply AI`;

      // Push tasks to broker
      for (const to of emailList) {
        broker.push({
          jobId,
          to,
          subject,
          body: taggedBody,
          fromName,
          replyTo,
          resume: resume ? {
            originalname: resume.originalname,
            buffer: resume.buffer
          } : undefined
        });
      }

      res.json({ jobId });
    } catch (error) {
      console.error("Server error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
