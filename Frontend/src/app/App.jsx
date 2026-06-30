import "./App.css"
import { Editor } from "@monaco-editor/react"
import { MonacoBinding } from "y-monaco"
import { useRef, useMemo, useState, useEffect, useCallback } from "react"
import * as Y from "yjs"
import { SocketIOProvider } from "y-socket.io"
import { io } from "socket.io-client"
import { nanoid } from "nanoid"

// ── User color palette ──────────────────────────────────────────────────────
const USER_COLORS = [
  "#f87171", "#fb923c", "#facc15", "#4ade80",
  "#34d399", "#38bdf8", "#818cf8", "#e879f9",
  "#f472b6", "#a78bfa"
]

function getColor(username) {
  let hash = 0
  for (const c of username) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length]
}

const LANGUAGES = [
  { label: "JavaScript", value: "javascript" },
  { label: "TypeScript", value: "typescript" },
  { label: "Python",     value: "python"     },
  { label: "Go",         value: "go"         },
  { label: "Rust",       value: "rust"       },
  { label: "C++",        value: "cpp"        },
  { label: "Java",       value: "java"       },
  { label: "HTML",       value: "html"       },
  { label: "CSS",        value: "css"        },
  { label: "JSON",       value: "json"       },
]

const FILE_EXT = {
  javascript: "js", typescript: "ts", python: "py", go: "go",
  rust: "rs", cpp: "cpp", java: "java", html: "html", css: "css", json: "json"
}

// ── Utility: get or create roomId from URL ──────────────────────────────────
function getRoomId() {
  const params = new URLSearchParams(window.location.search)
  let roomId = params.get("room")
  let isNewRoom = false
  if (!roomId) {
    roomId = nanoid(8)
    isNewRoom = true
    params.set("room", roomId)
    window.history.replaceState({}, "", "?" + params.toString())
  }
  return { roomId, isNewRoom }
}

// ── Join Screen ─────────────────────────────────────────────────────────────
function JoinScreen({ onJoin, roomId, isNewRoom }) {
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [usePassword, setUsePassword] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const link = `${window.location.origin}?room=${roomId}`

  async function handleSubmit() {
    if (!name.trim()) return
    setError("")
    setLoading(true)
    try {
      const endpoint = isNewRoom ? "/api/room/create" : "/api/room/join"
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId,
          username: name.trim(),
          password: usePassword ? password : undefined
        })
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.message || "Failed to join room")
        setLoading(false)
        return
      }
      onJoin(name.trim(), data.token)
    } catch (err) {
      setError("Could not reach the server. Is the backend running?")
      setLoading(false)
    }
  }

  return (
    <main className="h-screen w-full bg-gray-950 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8 w-full max-w-sm flex flex-col gap-5">
        <div>
          <h1 className="text-white text-2xl font-bold mb-1">CodeSync</h1>
          <p className="text-gray-400 text-sm">Real-time collaborative editor</p>
        </div>

        <div className="bg-gray-800 rounded-lg p-3">
          <p className="text-gray-400 text-xs mb-1">Room ID {isNewRoom && <span className="text-amber-400">(new)</span>}</p>
          <p className="text-amber-400 font-mono text-sm break-all">{roomId}</p>
          <button
            onClick={() => navigator.clipboard.writeText(link)}
            className="mt-2 text-xs text-gray-400 hover:text-white transition-colors"
          >
            Copy invite link
          </button>
        </div>

        <div className="flex flex-col gap-3">
          <input
            type="text"
            placeholder="Enter your username"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !usePassword && handleSubmit()}
            className="p-3 rounded-lg bg-gray-800 text-white border border-gray-700 focus:outline-none focus:border-amber-400"
            autoFocus
            maxLength={30}
          />

          {isNewRoom && (
            <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={usePassword}
                onChange={e => setUsePassword(e.target.checked)}
                className="accent-amber-400"
              />
              Protect this room with a password
            </label>
          )}

          {(usePassword || !isNewRoom) && (
            <input
              type="password"
              placeholder={isNewRoom ? "Set a room password" : "Room password (if required)"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              className="p-3 rounded-lg bg-gray-800 text-white border border-gray-700 focus:outline-none focus:border-amber-400"
              maxLength={100}
            />
          )}

          {error && <p className="text-red-400 text-xs">{error}</p>}

          <button
            onClick={handleSubmit}
            disabled={!name.trim() || loading}
            className="p-3 rounded-lg bg-amber-400 text-gray-950 font-bold hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Joining…" : isNewRoom ? "Create Room" : "Join Room"}
          </button>
        </div>
      </div>
    </main>
  )
}

// ── Main Editor App ─────────────────────────────────────────────────────────
export default function App() {
  const { roomId, isNewRoom } = useMemo(getRoomId, [])
  const [username, setUsername] = useState("")
  const [token, setToken]       = useState(null)
  const [joined, setJoined]     = useState(false)

  // Editor state
  const editorRef   = useRef(null)
  const [language, setLanguage] = useState("javascript")
  const monacoRef   = useRef(null)

  // Users & presence
  const [users, setUsers]           = useState([])
  const [typingUsers, setTypingUsers] = useState(new Set())

  // Connection status
  const [connected, setConnected]   = useState(false)
  const [ping, setPing]             = useState(null)
  const pingTimerRef = useRef(null)
  const pingStartRef = useRef(null)

  // Chat
  const [chatOpen, setChatOpen]     = useState(false)
  const [messages, setMessages]     = useState([])
  const [chatInput, setChatInput]   = useState("")
  const [unread, setUnread]         = useState(0)
  const chatBottomRef = useRef(null)

  // Socket + Yjs refs
  const socketRef   = useRef(null)
  const providerRef = useRef(null)
  const ydocRef     = useRef(new Y.Doc())
  const typingTimeoutRef = useRef(null)

  // ── Join ──────────────────────────────────────────────────────────
  function handleJoin(name, authToken) {
    setUsername(name)
    setToken(authToken)
    setJoined(true)
  }

  // ── Setup socket + Yjs on join ────────────────────────────────────
  useEffect(() => {
    if (!joined || !username || !token) return

    const socket = io("/", {
      transports: ["websocket"],
      auth: { token }
    })
    socketRef.current = socket

    // Connection events — server auto-joins the room based on the JWT payload
    socket.on("connect", () => {
      setConnected(true)
      startPing(socket)
    })
    socket.on("disconnect", () => {
      setConnected(false)
      setPing(null)
    })
    socket.on("connect_error", (err) => {
      console.error("Connection rejected:", err.message)
      if (err.message === "AUTH_REQUIRED" || err.message === "AUTH_INVALID") {
        addSystemMsg("Session expired. Please rejoin.")
        setJoined(false)
        setToken(null)
      }
    })

    // Ping / latency
    socket.on("pong", () => {
      if (pingStartRef.current) {
        setPing(Date.now() - pingStartRef.current)
      }
    })

    // Room users
    socket.on("room-users", (users) => setUsers(users))
    socket.on("user-joined", ({ username: u }) => {
      addSystemMsg(`${u} joined`)
    })
    socket.on("user-left", ({ username: u }) => {
      addSystemMsg(`${u} left`)
    })

    // Typing
    socket.on("user-typing", ({ username: u, isTyping }) => {
      setTypingUsers(prev => {
        const next = new Set(prev)
        isTyping ? next.add(u) : next.delete(u)
        return next
      })
    })

    // Chat
    socket.on("chat-history", (history) => setMessages(history.map(m => ({ ...m, system: false }))))
    socket.on("chat-message", (msg) => {
      setMessages(prev => [...prev, { ...msg, system: false }])
      setChatOpen(open => {
        if (!open) setUnread(u => u + 1)
        return open
      })
    })

    // Yjs provider
    const provider = new SocketIOProvider("/", roomId, ydocRef.current, {
      autoConnect: true,
      socket,
    })
    providerRef.current = provider

    const color = getColor(username)
    provider.awareness.setLocalStateField("user", { username, color })

    provider.awareness.on("change", () => {
      const states = Array.from(provider.awareness.getStates().values())
      setUsers(states
        .filter(s => s.user?.username)
        .map(s => s.user)
      )
    })

    return () => {
      clearInterval(pingTimerRef.current)
      provider.disconnect()
      socket.disconnect()
    }
  }, [joined, username, roomId])

  // ── Ping loop ──────────────────────────────────────────────────────
  function startPing(socket) {
    clearInterval(pingTimerRef.current)
    pingTimerRef.current = setInterval(() => {
      pingStartRef.current = Date.now()
      socket.emit("ping")
    }, 3000)
  }

  // ── System message helper ──────────────────────────────────────────
  function addSystemMsg(text) {
    setMessages(prev => [...prev, { system: true, message: text, timestamp: Date.now() }])
  }

  // ── Monaco mount ──────────────────────────────────────────────────
  function handleEditorMount(editor, monaco) {
    editorRef.current = editor
    monacoRef.current = monaco

    const yText = ydocRef.current.getText("monaco")
    new MonacoBinding(
      yText,
      editor.getModel(),
      new Set([editor]),
      providerRef.current?.awareness
    )

    // Typing indicator on keydown
    editor.onKeyDown(() => {
      socketRef.current?.emit("typing", { isTyping: true })
      clearTimeout(typingTimeoutRef.current)
      typingTimeoutRef.current = setTimeout(() => {
        socketRef.current?.emit("typing", { isTyping: false })
      }, 1500)
    })
  }

  // ── Language change ────────────────────────────────────────────────
  function handleLanguageChange(lang) {
    setLanguage(lang)
    if (editorRef.current && monacoRef.current) {
      monacoRef.current.editor.setModelLanguage(editorRef.current.getModel(), lang)
    }
  }

  // ── Export code ────────────────────────────────────────────────────
  function handleExport() {
    const code = editorRef.current?.getValue() || ""
    const ext  = FILE_EXT[language] || "txt"
    const blob = new Blob([code], { type: "text/plain" })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement("a")
    a.href     = url
    a.download = `codesync-${roomId}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ── Send chat ──────────────────────────────────────────────────────
  function sendChat() {
    if (!chatInput.trim()) return
    socketRef.current?.emit("chat-message", { message: chatInput.trim() })
    setChatInput("")
  }

  // Scroll chat to bottom on new messages
  useEffect(() => {
    if (chatOpen) {
      chatBottomRef.current?.scrollIntoView({ behavior: "smooth" })
      setUnread(0)
    }
  }, [messages, chatOpen])

  const typingList = Array.from(typingUsers)
  const pingColor  = ping === null ? "text-gray-500"
                   : ping < 80    ? "text-green-400"
                   : ping < 200   ? "text-yellow-400"
                                  : "text-red-400"

  // ── Join screen ────────────────────────────────────────────────────
  if (!joined) return <JoinScreen onJoin={handleJoin} roomId={roomId} isNewRoom={isNewRoom} />

  // ── Editor UI ──────────────────────────────────────────────────────
  return (
    <main className="h-screen w-full bg-gray-950 flex flex-col">

      {/* ── Top bar ── */}
      <header className="h-12 bg-gray-900 border-b border-gray-800 flex items-center px-4 gap-3 shrink-0">
        <span className="text-amber-400 font-bold text-sm tracking-wide">CodeSync</span>
        <span className="text-gray-600 text-xs font-mono">#{roomId}</span>

        {/* Connection badge */}
        <span className={`flex items-center gap-1.5 text-xs ml-1 ${connected ? "text-green-400" : "text-red-400"}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
          {connected ? "Connected" : "Reconnecting…"}
        </span>

        {/* Ping */}
        {ping !== null && (
          <span className={`text-xs ${pingColor}`}>{ping}ms</span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Language selector */}
          <select
            value={language}
            onChange={e => handleLanguageChange(e.target.value)}
            className="text-xs bg-gray-800 text-gray-200 border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-amber-400"
          >
            {LANGUAGES.map(l => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>

          {/* Export */}
          <button
            onClick={handleExport}
            className="text-xs bg-gray-800 text-gray-200 border border-gray-700 rounded px-3 py-1 hover:bg-gray-700 transition-colors"
          >
            Export
          </button>

          {/* Chat toggle */}
          <button
            onClick={() => { setChatOpen(o => !o); setUnread(0) }}
            className="relative text-xs bg-gray-800 text-gray-200 border border-gray-700 rounded px-3 py-1 hover:bg-gray-700 transition-colors"
          >
            Chat
            {unread > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-amber-400 text-gray-950 text-xs rounded-full w-4 h-4 flex items-center justify-center font-bold">
                {unread}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar — users */}
        <aside className="w-52 bg-gray-900 border-r border-gray-800 flex flex-col shrink-0">
          <div className="px-4 py-3 border-b border-gray-800">
            <p className="text-xs text-gray-400 uppercase tracking-wider">
              Online · {users.length}
            </p>
          </div>
          <ul className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
            {users.map((user, i) => (
              <li key={i} className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: getColor(user.username) }}
                />
                <span className="text-sm text-gray-200 truncate">{user.username}</span>
                {user.username === username && (
                  <span className="text-xs text-gray-500 ml-auto">you</span>
                )}
              </li>
            ))}
          </ul>

          {/* Typing indicator */}
          {typingList.length > 0 && (
            <div className="px-4 py-2 border-t border-gray-800">
              <p className="text-xs text-gray-400 italic truncate">
                {typingList.slice(0, 2).join(", ")}
                {typingList.length > 2 ? ` +${typingList.length - 2}` : ""}
                {" typing…"}
              </p>
            </div>
          )}
        </aside>

        {/* Monaco editor */}
        <section className="flex-1 overflow-hidden">
          <Editor
            height="100%"
            language={language}
            defaultValue={`// Welcome to CodeSync — room #${roomId}\n// Share the URL to invite others!\n`}
            theme="vs-dark"
            onMount={handleEditorMount}
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              padding: { top: 16 },
              scrollBeyondLastLine: false,
            }}
          />
        </section>

        {/* Chat panel */}
        {chatOpen && (
          <aside className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
              <p className="text-xs text-gray-400 uppercase tracking-wider">Chat</p>
              <button onClick={() => setChatOpen(false)} className="text-gray-500 hover:text-white text-xs">✕</button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
              {messages.map((msg, i) =>
                msg.system ? (
                  <p key={i} className="text-xs text-gray-500 text-center">{msg.message}</p>
                ) : (
                  <div key={i} className={`flex flex-col ${msg.username === username ? "items-end" : "items-start"}`}>
                    <span className="text-xs text-gray-500 mb-0.5">{msg.username}</span>
                    <div
                      className="text-sm rounded-lg px-3 py-2 max-w-[90%] break-words"
                      style={{
                        background: msg.username === username ? "#b45309" : "#1f2937",
                        color: "#f3f4f6"
                      }}
                    >
                      {msg.message}
                    </div>
                  </div>
                )
              )}
              <div ref={chatBottomRef} />
            </div>

            <div className="p-3 border-t border-gray-800 flex gap-2">
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && sendChat()}
                placeholder="Message…"
                className="flex-1 text-sm bg-gray-800 text-white rounded px-3 py-2 border border-gray-700 focus:outline-none focus:border-amber-400"
              />
              <button
                onClick={sendChat}
                className="text-sm bg-amber-400 text-gray-950 rounded px-3 py-2 font-bold hover:bg-amber-300 transition-colors"
              >
                Send
              </button>
            </div>
          </aside>
        )}
      </div>
    </main>
  )
}
