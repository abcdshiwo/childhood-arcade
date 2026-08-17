import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'

import { useWebRTC } from '../src/composables/useWebRTC.js'

class FakeDataChannel {
  constructor(label, options = {}) {
    this.label = label
    this.options = options
    this.readyState = 'connecting'
    this.sent = []
  }

  open() {
    this.readyState = 'open'
    this.onopen?.()
  }

  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.()
  }
}

class FakePeerConnection {
  static instances = []

  constructor() {
    this.channels = []
    this.connectionState = 'new'
    this.iceConnectionState = 'new'
    FakePeerConnection.instances.push(this)
  }

  createDataChannel(label, options) {
    const channel = new FakeDataChannel(label, options)
    this.channels.push(channel)
    return channel
  }

  addTrack() {}
  async createOffer() { return { type: 'offer', sdp: 'offer' } }
  async createAnswer() { return { type: 'answer', sdp: 'answer' } }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() { this.connectionState = 'closed' }
}

const stream = { getTracks: () => [] }

function signalStub() {
  return {
    sendIce() {},
    sendOffer() {},
    sendAnswer() {},
  }
}

function incomingControlsChannel(peerConnection, peerId = 'host') {
  const channel = new FakeDataChannel('controls', { ordered: true })
  peerConnection.ondatachannel({ channel })
  channel.open()
  return channel
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

beforeEach(() => {
  FakePeerConnection.instances.length = 0
  globalThis.RTCPeerConnection = FakePeerConnection
  globalThis.RTCSessionDescription = class {
    constructor(description) { Object.assign(this, description) }
  }
})

afterEach(() => {
  delete globalThis.RTCPeerConnection
  delete globalThis.RTCSessionDescription
})

test('host creates separate unreliable input and reliable ordered controls channels', async () => {
  const rtc = useWebRTC({ signal: signalStub() })
  await rtc.startCall('guest-1', stream)

  const channels = FakePeerConnection.instances[0].channels
  assert.deepEqual(channels.map(({ label }) => label), ['input', 'controls'])
  assert.deepEqual(channels[0].options, { ordered: false, maxRetransmits: 0 })
  assert.deepEqual(channels[1].options, { ordered: true })
  rtc.close()
})

test('guest retries one epoch-sequence pulse ID until ACK then stops', async () => {
  const epochs = ['guest-session-a', 'guest-session-b']
  const rtc = useWebRTC({
    signal: signalStub(),
    controlAckTimeoutMs: 10,
    controlMaxAttempts: 3,
    createControlEpoch: () => epochs.shift(),
  })
  await rtc.handleOffer('host', { type: 'offer', sdp: 'offer' })
  const controls = incomingControlsChannel(FakePeerConnection.instances[0])

  const acknowledged = rtc.sendControlPulse('select')
  assert.deepEqual(controls.sent[0], {
    type: 'control-pulse',
    id: 'guest-session-a:1',
    button: 'select',
  })
  await delay(15)
  assert.equal(controls.sent.length, 2)
  assert.equal(controls.sent[1].id, controls.sent[0].id)

  controls.receive({ type: 'control-ack', id: 'guest-session-a:1' })
  assert.equal(await acknowledged, true)
  await delay(15)
  assert.equal(controls.sent.length, 2)

  rtc.closePeer('host')
  await rtc.handleOffer('host', { type: 'offer', sdp: 'offer-2' })
  const reconnected = incomingControlsChannel(FakePeerConnection.instances[1])
  const pending = rtc.sendControlPulse('start')
  assert.equal(reconnected.sent[0].id, 'guest-session-b:1')
  rtc.close()
  assert.equal(await pending, false)
})

test('host ACKs duplicate control pulses but executes each ID once', async () => {
  const received = []
  const rtc = useWebRTC({
    signal: signalStub(),
    onControlPulse: (message, peerId) => received.push({ message, peerId }),
  })
  await rtc.handleOffer('guest-1', { type: 'offer', sdp: 'offer' })
  const controls = incomingControlsChannel(FakePeerConnection.instances[0], 'guest-1')
  const pulse = { type: 'control-pulse', id: 'guest-session:7', button: 'start' }

  controls.receive(pulse)
  controls.receive(pulse)

  assert.deepEqual(received, [{ message: pulse, peerId: 'guest-1' }])
  assert.deepEqual(controls.sent, [
    { type: 'control-ack', id: pulse.id },
    { type: 'control-ack', id: pulse.id },
  ])
  rtc.close()
})

test('closing a controls channel cancels retry timers and settles pending pulses', async () => {
  const rtc = useWebRTC({
    signal: signalStub(),
    controlAckTimeoutMs: 10,
    controlMaxAttempts: 3,
    createControlEpoch: () => 'guest-session',
  })
  await rtc.handleOffer('host', { type: 'offer', sdp: 'offer' })
  const controls = incomingControlsChannel(FakePeerConnection.instances[0])
  const pending = rtc.sendControlPulse('select')

  controls.close()
  assert.equal(await pending, false)
  await delay(20)
  assert.equal(controls.sent.length, 1)
  rtc.close()
})

test('a disconnected peer cancels pending control retries immediately', async () => {
  const rtc = useWebRTC({
    signal: signalStub(),
    controlAckTimeoutMs: 10,
    controlMaxAttempts: 3,
    createControlEpoch: () => 'guest-session',
  })
  await rtc.handleOffer('host', { type: 'offer', sdp: 'offer' })
  const controls = incomingControlsChannel(FakePeerConnection.instances[0])
  const pending = rtc.sendControlPulse('start')
  const peer = FakePeerConnection.instances[0]

  peer.connectionState = 'disconnected'
  peer.onconnectionstatechange()

  assert.equal(await pending, false)
  await delay(20)
  assert.equal(controls.sent.length, 1)
  rtc.close()
})
