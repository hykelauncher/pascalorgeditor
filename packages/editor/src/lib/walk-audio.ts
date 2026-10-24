import useAudio from '../store/use-audio'

/**
 * The walkthrough's own sounds, made in Web Audio rather than shipped as files: footsteps, the
 * thud of a door or gate and the click of a switch, and the hum of a running fan, louder as the
 * walker comes close. They follow the editor's master and effects volumes and its mute.
 */
let context: AudioContext | null = null
let noise: AudioBuffer | null = null

function audio(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext === 'undefined') return null
  if (!context) context = new window.AudioContext()
  // Browsers start a context suspended until a gesture; entering the walk is one.
  if (context.state === 'suspended') void context.resume().catch(() => {})
  return context
}

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noise) return noise
  noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
  const data = noise.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return noise
}

function volume(): number {
  const { masterVolume, sfxVolume, muted } = useAudio.getState()
  return muted ? 0 : (masterVolume / 100) * (sfxVolume / 100)
}

/** A burst of filtered noise with a fast attack and the given decay. */
function burst(frequency: number, decay: number, peak: number) {
  const ctx = audio()
  const level = volume() * peak
  if (!ctx || level <= 0) return
  const source = ctx.createBufferSource()
  source.buffer = noiseBuffer(ctx)
  source.playbackRate.value = 0.8 + Math.random() * 0.4
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = frequency
  const gain = ctx.createGain()
  const now = ctx.currentTime
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(level, now + 0.006)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + decay)
  source.connect(filter).connect(gain).connect(ctx.destination)
  source.start(now, Math.random() * 0.5)
  source.stop(now + decay + 0.02)
}

/** A falling tone: the body of a door or gate coming to rest. */
function thud(frequency: number, decay: number, peak: number) {
  const ctx = audio()
  const level = volume() * peak
  if (!ctx || level <= 0) return
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  const gain = ctx.createGain()
  const now = ctx.currentTime
  osc.frequency.setValueAtTime(frequency, now)
  osc.frequency.exponentialRampToValueAtTime(frequency * 0.55, now + decay)
  gain.gain.setValueAtTime(level, now)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + decay)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + decay + 0.02)
}

export function playFootstep(running: boolean) {
  burst(running ? 900 : 650, running ? 0.09 : 0.12, running ? 0.32 : 0.24)
}

export function playWalkSound(kind: 'door' | 'switch') {
  if (kind === 'door') {
    thud(110, 0.28, 0.5)
    burst(1800, 0.05, 0.18)
  } else {
    burst(4000, 0.025, 0.35)
  }
}

// --- Fan hum -------------------------------------------------------------------------------

let hum: { gain: GainNode; stop: () => void } | null = null
const HUM_RANGE = 6

/** Sets the hum for the nearest running fan (`null` when none runs): full under it, gone at 6 m. */
export function setFanHum(distance: number | null) {
  const level = distance === null ? 0 : volume() * 0.14 * Math.max(0, 1 - distance / HUM_RANGE)
  if (level <= 0) {
    if (hum) {
      const ctx = audio()
      if (ctx) hum.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.15)
    }
    return
  }
  const ctx = audio()
  if (!ctx) return
  if (!hum) {
    const source = ctx.createBufferSource()
    source.buffer = noiseBuffer(ctx)
    source.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 260
    // The blades' slow beat: a quarter of the hum, whatever its level.
    const beat = ctx.createOscillator()
    beat.frequency.value = 3.2
    const depth = ctx.createGain()
    depth.gain.value = 0.25
    const tremolo = ctx.createGain()
    tremolo.gain.value = 0.75
    beat.connect(depth).connect(tremolo.gain)
    const gain = ctx.createGain()
    gain.gain.value = 0
    source.connect(filter).connect(tremolo).connect(gain).connect(ctx.destination)
    source.start()
    beat.start()
    hum = {
      gain,
      stop: () => {
        source.stop()
        beat.stop()
        gain.disconnect()
      },
    }
  }
  hum.gain.gain.setTargetAtTime(level, ctx.currentTime, 0.15)
}

export function stopWalkAudio() {
  hum?.stop()
  hum = null
}
