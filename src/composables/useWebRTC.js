// RTCPeerConnection wrapper for host↔guest video/audio plus separate data
// channels for realtime input and acknowledged toolbar controls. The signaling
// layer (useRoomSignal) is injected so SDP offers/answers/ICE candidates travel
// through our own server.
//
// Host: calls startCall(peerId, stream) to offer media + both channels.
// Guest: listens passively — handleOffer creates a PC answering the host,
//        exposing the incoming stream via onRemoteStream and DC msgs via
//        onDataMessage.

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
}

const CONTROL_BUTTONS = new Set(['select', 'start'])
const DEFAULT_CONTROL_ACK_TIMEOUT_MS = 250
const DEFAULT_CONTROL_MAX_ATTEMPTS = 3
const INVALID_MESSAGE = Symbol('invalid-message')
let fallbackControlEpoch = 0

function defaultCreateControlEpoch() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {}
  fallbackControlEpoch += 1
  return `${Date.now().toString(36)}-${fallbackControlEpoch.toString(36)}`
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function parsedMessage(event) {
  try { return JSON.parse(event.data) } catch { return INVALID_MESSAGE }
}

function validControlId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) return false
  const separator = id.lastIndexOf(':')
  if (separator <= 0 || separator === id.length - 1) return false
  return id.slice(0, separator).trim().length > 0
    && /^[1-9]\d*$/.test(id.slice(separator + 1))
}

export function useWebRTC({
  signal,
  onRemoteStream,
  onDataMessage,
  onControlPulse,
  onStateChange,
  controlAckTimeoutMs = DEFAULT_CONTROL_ACK_TIMEOUT_MS,
  controlMaxAttempts = DEFAULT_CONTROL_MAX_ATTEMPTS,
  createControlEpoch = defaultCreateControlEpoch,
}) {
  const ackTimeoutMs = positiveNumber(controlAckTimeoutMs, DEFAULT_CONTROL_ACK_TIMEOUT_MS)
  const maxControlAttempts = positiveInteger(controlMaxAttempts, DEFAULT_CONTROL_MAX_ATTEMPTS)

  // peerId → channel state and reliability bookkeeping for that peer.
  const peers = new Map()

  function settleControl(entry, id, acknowledged) {
    const pending = entry.pendingControls.get(id)
    if (!pending) return false
    entry.pendingControls.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(acknowledged)
    return true
  }

  function settleAllControls(entry, acknowledged = false) {
    for (const id of [...entry.pendingControls.keys()]) {
      settleControl(entry, id, acknowledged)
    }
  }

  function nextControlEpoch() {
    try {
      const epoch = createControlEpoch?.()
      if (typeof epoch === 'string' && epoch.trim().length > 0 && epoch.length <= 240) return epoch
    } catch {}
    return defaultCreateControlEpoch()
  }

  function resetControlSession(entry) {
    settleAllControls(entry)
    entry.controlEpoch = nextControlEpoch()
    entry.controlSequence = 0
    entry.handledControlIds.clear()
  }

  function sendControlAttempt(entry, pending) {
    if (!entry.pendingControls.has(pending.id)) return
    const dc = entry.controlsDc
    if (!dc || dc !== pending.channel || dc.readyState !== 'open') {
      settleControl(entry, pending.id, false)
      return
    }

    pending.attempts += 1
    try { dc.send(pending.payload) } catch {}
    if (!entry.pendingControls.has(pending.id)) return
    pending.timer = setTimeout(() => {
      pending.timer = null
      if (!entry.pendingControls.has(pending.id)) return
      if (pending.attempts >= maxControlAttempts) {
        settleControl(entry, pending.id, false)
        return
      }
      sendControlAttempt(entry, pending)
    }, ackTimeoutMs)
  }

  function handleControlMessage(entry, dc, message) {
    if (
      entry.controlsDc !== dc
      || dc.readyState !== 'open'
      || !message
      || typeof message !== 'object'
      || Array.isArray(message)
    ) return

    if (message.type === 'control-ack') {
      if (validControlId(message.id)) settleControl(entry, message.id, true)
      return
    }

    if (
      message.type !== 'control-pulse'
      || !validControlId(message.id)
      || !CONTROL_BUTTONS.has(message.button)
    ) return

    if (dc.readyState === 'open') {
      try { dc.send(JSON.stringify({ type: 'control-ack', id: message.id })) } catch {}
    }
    if (entry.handledControlIds.has(message.id)) return
    entry.handledControlIds.add(message.id)
    onControlPulse?.(message, entry.peerId)
  }

  function wireInputChannel(entry, dc) {
    dc.onopen = () => onStateChange?.('dc:open')
    dc.onclose = () => {
      if (entry.inputDc === dc) {
        entry.inputDc = null
        settleAllControls(entry)
      }
      onStateChange?.('dc:close')
    }
    dc.onmessage = (event) => {
      if (entry.inputDc !== dc) return
      const message = parsedMessage(event)
      if (message !== INVALID_MESSAGE) onDataMessage?.(message)
    }
  }

  function wireControlsChannel(entry, dc) {
    dc.onopen = () => {
      if (entry.controlsDc !== dc) return
      resetControlSession(entry)
      onStateChange?.('controls:open')
    }
    dc.onclose = () => {
      if (entry.controlsDc === dc) {
        entry.controlsDc = null
        entry.controlEpoch = null
        entry.controlSequence = 0
        entry.handledControlIds.clear()
        settleAllControls(entry)
      }
      onStateChange?.('controls:close')
    }
    dc.onmessage = (event) => {
      const message = parsedMessage(event)
      if (message !== INVALID_MESSAGE) handleControlMessage(entry, dc, message)
    }
  }

  function attachInputChannel(entry, dc) {
    if (entry.inputDc && entry.inputDc !== dc) {
      settleAllControls(entry)
      try { entry.inputDc.close() } catch {}
    }
    entry.inputDc = dc
    wireInputChannel(entry, dc)
  }

  function attachControlsChannel(entry, dc) {
    if (entry.controlsDc && entry.controlsDc !== dc) {
      settleAllControls(entry)
      try { entry.controlsDc.close() } catch {}
    }
    entry.controlsDc = dc
    wireControlsChannel(entry, dc)
  }

  function attachIncomingChannel(entry, dc) {
    if (dc?.label === 'input') {
      attachInputChannel(entry, dc)
    } else if (dc?.label === 'controls') {
      attachControlsChannel(entry, dc)
    } else {
      try { dc?.close() } catch {}
    }
  }

  function getOrCreate(peerId, { initiatorStream = null } = {}) {
    let entry = peers.get(peerId)
    if (entry) return entry

    const pc = new RTCPeerConnection(ICE_CONFIG)
    entry = {
      peerId,
      pc,
      inputDc: null,
      controlsDc: null,
      controlEpoch: null,
      controlSequence: 0,
      pendingControls: new Map(),
      handledControlIds: new Set(),
    }
    peers.set(peerId, entry)

    pc.onicecandidate = (ev) => {
      if (ev.candidate) signal.sendIce(peerId, ev.candidate)
    }
    pc.ontrack = (ev) => {
      onRemoteStream?.(ev.streams[0])
    }
    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === 'disconnected'
        || pc.connectionState === 'closed'
        || pc.connectionState === 'failed'
      ) {
        settleAllControls(entry)
      }
      onStateChange?.(pc.connectionState)
    }
    pc.oniceconnectionstatechange = () => {
      if (
        pc.iceConnectionState === 'disconnected'
        || pc.iceConnectionState === 'closed'
        || pc.iceConnectionState === 'failed'
      ) {
        settleAllControls(entry)
      }
      onStateChange?.('ice:' + pc.iceConnectionState)
    }
    pc.ondatachannel = (ev) => {
      // Guest (non-initiator) receives the host's labeled channels here.
      attachIncomingChannel(entry, ev.channel)
    }

    if (initiatorStream) {
      for (const track of initiatorStream.getTracks()) {
        pc.addTrack(track, initiatorStream)
      }
      attachInputChannel(
        entry,
        pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 }),
      )
      attachControlsChannel(
        entry,
        pc.createDataChannel('controls', { ordered: true }),
      )
    }

    return entry
  }

  async function startCall(peerId, stream) {
    const { pc } = getOrCreate(peerId, { initiatorStream: stream })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    signal.sendOffer(peerId, offer)
  }

  async function handleOffer(fromPeerId, sdp) {
    const { pc } = getOrCreate(fromPeerId)
    await pc.setRemoteDescription(new RTCSessionDescription(sdp))
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    signal.sendAnswer(fromPeerId, answer)
  }

  async function handleAnswer(fromPeerId, sdp) {
    const entry = peers.get(fromPeerId)
    if (!entry) return
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp))
  }

  async function handleIce(fromPeerId, candidate) {
    const entry = peers.get(fromPeerId)
    if (!entry) return
    try { await entry.pc.addIceCandidate(candidate) } catch (err) {
      // remote candidate may arrive before we've set remote description; swallow
    }
  }

  function sendData(msg) {
    const data = JSON.stringify(msg)
    for (const { inputDc } of peers.values()) {
      if (inputDc && inputDc.readyState === 'open') {
        try { inputDc.send(data) } catch {}
      }
    }
  }

  function sendControlPulse(button) {
    if (!CONTROL_BUTTONS.has(button)) return Promise.resolve(false)
    const entry = [...peers.values()].find(({ controlsDc, controlEpoch }) => (
      controlsDc?.readyState === 'open' && controlEpoch
    ))
    if (!entry) return Promise.resolve(false)

    entry.controlSequence += 1
    const id = `${entry.controlEpoch}:${entry.controlSequence}`
    const message = { type: 'control-pulse', id, button }
    const payload = JSON.stringify(message)

    return new Promise((resolve) => {
      const pending = {
        id,
        channel: entry.controlsDc,
        payload,
        attempts: 0,
        timer: null,
        resolve,
      }
      entry.pendingControls.set(id, pending)
      sendControlAttempt(entry, pending)
    })
  }

  function closeEntry(entry) {
    settleAllControls(entry)
    try { entry.inputDc?.close() } catch {}
    try { entry.controlsDc?.close() } catch {}
    try { entry.pc.close() } catch {}
    entry.inputDc = null
    entry.controlsDc = null
    entry.controlEpoch = null
    entry.controlSequence = 0
    entry.handledControlIds.clear()
  }

  function close() {
    for (const entry of peers.values()) closeEntry(entry)
    peers.clear()
  }

  function closePeer(peerId) {
    const entry = peers.get(peerId)
    if (!entry) return
    closeEntry(entry)
    peers.delete(peerId)
  }

  return {
    startCall,
    handleOffer,
    handleAnswer,
    handleIce,
    sendData,
    sendControlPulse,
    closePeer,
    close,
  }
}
