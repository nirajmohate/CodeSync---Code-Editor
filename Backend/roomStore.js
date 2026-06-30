import { createClient } from "redis"
import bcrypt from "bcryptjs"
import * as Y from "yjs"

let redisClient = null
let memoryStore = null // fallback if Redis isn't configured

export async function initStore() {
    const redisUrl = process.env.REDIS_URL

    if (redisUrl) {
        redisClient = createClient({ url: redisUrl })
        redisClient.on("error", (err) => console.error("[redis] error:", err.message))
        await redisClient.connect()
        console.log("✅ Connected to Redis — rooms will persist across restarts")
    } else {
        memoryStore = new Map()
        console.log("⚠️  No REDIS_URL set — using in-memory store (rooms will NOT survive restarts)")
    }
}

function key(roomId) {
    return `codesync:room:${roomId}`
}

// ── Room metadata (password hash, owner, createdAt) ─────────────────────────
export async function createRoomMeta(roomId, { password, owner }) {
    const passwordHash = password ? await bcrypt.hash(password, 10) : null
    const meta = {
        owner,
        passwordHash,
        createdAt: Date.now(),
        hasPassword: !!password
    }
    if (redisClient) {
        await redisClient.set(`${key(roomId)}:meta`, JSON.stringify(meta), { NX: true, EX: 60 * 60 * 24 * 30 })
    } else {
        if (!memoryStore.has(`${roomId}:meta`)) {
            memoryStore.set(`${roomId}:meta`, meta)
        }
    }
    return getRoomMeta(roomId)
}

export async function getRoomMeta(roomId) {
    if (redisClient) {
        const raw = await redisClient.get(`${key(roomId)}:meta`)
        return raw ? JSON.parse(raw) : null
    }
    return memoryStore.get(`${roomId}:meta`) || null
}

export async function verifyRoomPassword(roomId, password) {
    const meta = await getRoomMeta(roomId)
    if (!meta || !meta.hasPassword) return true // no password set = open room
    if (!password) return false
    return bcrypt.compare(password, meta.passwordHash)
}

// ── Yjs document persistence (binary state snapshot) ────────────────────────
export async function saveDocState(roomId, ydoc) {
    const update = Y.encodeStateAsUpdate(ydoc)
    const base64 = Buffer.from(update).toString("base64")
    if (redisClient) {
        await redisClient.set(`${key(roomId)}:doc`, base64, { EX: 60 * 60 * 24 * 30 })
    } else {
        memoryStore.set(`${roomId}:doc`, base64)
    }
}

export async function loadDocState(roomId, ydoc) {
    let base64
    if (redisClient) {
        base64 = await redisClient.get(`${key(roomId)}:doc`)
    } else {
        base64 = memoryStore.get(`${roomId}:doc`)
    }
    if (base64) {
        const update = Buffer.from(base64, "base64")
        Y.applyUpdate(ydoc, update)
        return true
    }
    return false
}

export function isRedisEnabled() {
    return !!redisClient
}
