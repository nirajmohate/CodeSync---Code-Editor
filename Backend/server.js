import express from "express"
import { createServer } from "http"
import { Server } from "socket.io"
import { YSocketIO } from "y-socket.io/dist/server"
import rateLimit from "express-rate-limit"
import helmet from "helmet"
import cors from "cors"
import dotenv from "dotenv"
import jwt from "jsonwebtoken"

import {
    initStore,
    createRoomMeta,
    getRoomMeta,
    verifyRoomPassword,
    saveDocState,
    loadDocState,
    isRedisEnabled
} from "./roomStore.js"
import { sanitizeText, isValidUsername, isValidRoomId } from "./validation.js"

dotenv.config()

const PORT = process.env.PORT || 3000
const NODE_ENV = process.env.NODE_ENV || "development"
const JWT_SECRET = process.env.JWT_SECRET
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map(s => s.trim())

if (!JWT_SECRET) {
    console.error("❌ JWT_SECRET is not set in .env")
    if (NODE_ENV === "production") process.exit(1)
}
const SECRET = JWT_SECRET || "dev-only-insecure-secret-change-me"

await initStore()

const app = express()
app.set("trust proxy", 1) // correct client IPs behind a reverse proxy / load balancer

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            connectSrc: ["'self'", "ws:", "wss:"],
            imgSrc: ["'self'", "data:"],
        }
    },
    crossOriginEmbedderPolicy: false
}))

// ── CORS (whitelist only) ───────────────────────────────────────────────────
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true)
        } else {
            callback(new Error("Not allowed by CORS"))
        }
    },
    credentials: true
}
app.use(cors(corsOptions))
app.use(express.json({ limit: "100kb" })) // cap body size — prevents large-payload abuse

app.use(express.static("public"))

// ── Rate limiting ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many requests, slow down." }
})
app.use("/api", apiLimiter)

const roomCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { success: false, message: "Too many room creation attempts." }
})

const httpServer = createServer(app)

const io = new Server(httpServer, {
    cors: corsOptions,
    maxHttpBufferSize: 1e6 // 1MB cap on socket payloads
})

const ySocketIO = new YSocketIO(io)
ySocketIO.initialize()

// In-memory live state (presence, chat) — ephemeral, doesn't need to survive restarts
const rooms = new Map()
const chatHistory = new Map()

// ── Periodic Yjs document persistence ───────────────────────────────────────
async function persistRoomDoc(roomId) {
    const doc = ySocketIO.getYDoc ? ySocketIO.getYDoc(roomId) : null
    if (doc) await saveDocState(roomId, doc)
}

// ── REST: create / verify room access ───────────────────────────────────────
app.post("/api/room/create", roomCreateLimiter, async (req, res) => {
    try {
        const { roomId, password, username } = req.body

        if (!isValidRoomId(roomId)) {
            return res.status(400).json({ success: false, message: "Invalid room ID" })
        }
        if (!isValidUsername(username)) {
            return res.status(400).json({ success: false, message: "Invalid username" })
        }
        if (password && (typeof password !== "string" || password.length > 100)) {
            return res.status(400).json({ success: false, message: "Invalid password" })
        }

        const meta = await createRoomMeta(roomId, { password, owner: username })

        const token = jwt.sign({ roomId, username }, SECRET, { expiresIn: "12h" })
        res.json({ success: true, token, hasPassword: meta.hasPassword })
    } catch (err) {
        console.error("[room/create]", err.message)
        res.status(500).json({ success: false, message: "Server error" })
    }
})

app.post("/api/room/join", apiLimiter, async (req, res) => {
    try {
        const { roomId, password, username } = req.body

        if (!isValidRoomId(roomId)) {
            return res.status(400).json({ success: false, message: "Invalid room ID" })
        }
        if (!isValidUsername(username)) {
            return res.status(400).json({ success: false, message: "Invalid username (1-30 chars, letters/numbers/spaces only)" })
        }

        const meta = await getRoomMeta(roomId)

        // Room doesn't exist yet — allow join, it'll be created implicitly (open room)
        if (!meta) {
            const token = jwt.sign({ roomId, username }, SECRET, { expiresIn: "12h" })
            return res.json({ success: true, token, hasPassword: false })
        }

        const valid = await verifyRoomPassword(roomId, password)
        if (!valid) {
            return res.status(401).json({ success: false, message: "Incorrect password" })
        }

        const token = jwt.sign({ roomId, username }, SECRET, { expiresIn: "12h" })
        res.json({ success: true, token, hasPassword: meta.hasPassword })
    } catch (err) {
        console.error("[room/join]", err.message)
        res.status(500).json({ success: false, message: "Server error" })
    }
})

app.get("/api/room/:roomId/info", apiLimiter, async (req, res) => {
    const { roomId } = req.params
    if (!isValidRoomId(roomId)) {
        return res.status(400).json({ success: false, message: "Invalid room ID" })
    }
    const meta = await getRoomMeta(roomId)
    const roomMap = rooms.get(roomId)
    res.json({
        roomId,
        exists: !!meta,
        hasPassword: meta?.hasPassword || false,
        userCount: roomMap?.size || 0
    })
})

app.get("/health", (req, res) => {
    res.status(200).json({ message: "ok", success: true, redis: isRedisEnabled() })
})

// ── Socket auth middleware — every connection must present a valid JWT ──────
io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token
        if (!token) return next(new Error("AUTH_REQUIRED"))
        const payload = jwt.verify(token, SECRET)
        socket.data.roomId = payload.roomId
        socket.data.username = payload.username
        next()
    } catch (err) {
        next(new Error("AUTH_INVALID"))
    }
})

io.on("connection", async (socket) => {
    const { roomId, username } = socket.data
    console.log(`[connect] ${username} -> ${roomId} (${socket.id})`)

    socket.on("ping", () => socket.emit("pong"))

    socket.join(roomId)

    if (!rooms.has(roomId)) rooms.set(roomId, new Map())
    rooms.get(roomId).set(socket.id, { username })

    // Restore persisted doc state on first connection to this room (Redis-backed)
    const doc = ySocketIO.getYDoc ? ySocketIO.getYDoc(roomId) : null
    if (doc && doc.share.size === 0) {
        await loadDocState(roomId, doc)
    }

    const history = chatHistory.get(roomId) || []
    socket.emit("chat-history", history)
    broadcastUsers(roomId)
    socket.to(roomId).emit("user-joined", { username })

    // ── Chat ──────────────────────────────────────────────────────────────
    socket.on("chat-message", ({ message }) => {
        if (!message || typeof message !== "string") return
        const clean = sanitizeText(message, 500)
        if (!clean) return

        const msg = { username: sanitizeText(username, 30), message: clean, timestamp: Date.now() }
        if (!chatHistory.has(roomId)) chatHistory.set(roomId, [])
        const hist = chatHistory.get(roomId)
        hist.push(msg)
        if (hist.length > 50) hist.shift()

        io.to(roomId).emit("chat-message", msg)
    })

    socket.on("typing", ({ isTyping }) => {
        socket.to(roomId).emit("user-typing", { username, isTyping: !!isTyping })
    })

    // ── Periodic doc persistence while connected ────────────────────────────
    const persistInterval = setInterval(() => persistRoomDoc(roomId), 15_000)

    socket.on("disconnect", async () => {
        clearInterval(persistInterval)
        rooms.get(roomId)?.delete(socket.id)
        if (rooms.get(roomId)?.size === 0) {
            rooms.delete(roomId)
            chatHistory.delete(roomId)
            await persistRoomDoc(roomId) // final save when room empties out
        }
        broadcastUsers(roomId)
        io.to(roomId).emit("user-left", { username })
        console.log(`[disconnect] ${username} (${socket.id})`)
    })
})

function broadcastUsers(roomId) {
    const roomMap = rooms.get(roomId)
    if (!roomMap) return
    io.to(roomId).emit("room-users", Array.from(roomMap.values()))
}

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    if (err.message === "Not allowed by CORS") {
        return res.status(403).json({ success: false, message: "Origin not allowed" })
    }
    console.error("[unhandled]", err)
    res.status(500).json({ success: false, message: "Internal server error" })
})

httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`\n❌ Port ${PORT} is already in use.`)
        console.error(`   Windows: netstat -ano | findstr :${PORT}  → taskkill /PID <pid> /F`)
        console.error(`   Mac/Linux: lsof -i :${PORT}  → kill -9 <pid>\n`)
        process.exit(1)
    } else {
        throw err
    }
})

httpServer.listen(PORT, () => {
    console.log(`\n✅ CodeSync server running on http://localhost:${PORT}`)
    console.log(`   Environment: ${NODE_ENV}`)
    console.log(`   Redis persistence: ${isRedisEnabled() ? "enabled" : "disabled (in-memory fallback)"}\n`)
})
