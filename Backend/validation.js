import validator from "validator"

// Strip any HTML/script content — prevents stored XSS in chat & usernames
export function sanitizeText(input, maxLen = 500) {
    if (typeof input !== "string") return ""
    const trimmed = input.trim().slice(0, maxLen)
    return validator.escape(trimmed) // escapes <, >, &, ', " etc.
}

export function isValidUsername(name) {
    if (typeof name !== "string") return false
    const trimmed = name.trim()
    return trimmed.length >= 1 && trimmed.length <= 30 && /^[a-zA-Z0-9 _-]+$/.test(trimmed)
}

export function isValidRoomId(roomId) {
    if (typeof roomId !== "string") return false
    return /^[a-zA-Z0-9_-]{4,32}$/.test(roomId)
}
