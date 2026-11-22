import { execFile } from 'node:child_process'
import os from 'node:os'

// What the computer can run, in the terms that decide which AI models make sense:
//  * the processor architecture, and whether Atlas itself is running natively or emulated (a Windows-on-Arm computer runs x64
//    programs in emulation; x64 Python, CUDA and ComfyUI packages must not be assumed to work there);
//  * the graphics card, its generation (which numeric precisions it computes quickly) and its driver;
//  * how much memory a model can really use: dedicated graphics memory is separate from the computer's memory; on machines with
//    unified memory (the NVIDIA RTX Spark Arm64 computers, Apple silicon) the graphics chip shares one large pool with the rest.
// Detection reads only; nothing is installed or changed. Everything pure is exported so it can be tested with captured output
// and with simulated profiles.

import type { Arch, GpuFamily, GpuInfo, HardwareProfile, MemoryKind, Precisions, RuntimeCompat, Tier } from '../../shared/modelLibrary'
import { TIER_LABEL } from '../../shared/modelLibrary'
export * from '../../shared/modelLibrary'
void TIER_LABEL

const GB = 1024 ** 3
const round1 = (v: number): number => Math.round(v * 10) / 10

// ---- the graphics card -------------------------------------------------------------------------------------------------------

export function inferNvidia(name: string): { family: GpuFamily; series: string | null; capability: string | null } {
  const n = name.toUpperCase()
  if (/SPARK|GB10|GB20|GRACE/.test(n)) return { family: 'blackwell', series: 'RTX Spark', capability: '12.1' }
  if (/RTX\s*PRO\s*\d+0?0?\s*BLACKWELL|RTX\s*50\d{2}/.test(n)) return { family: 'blackwell', series: 'RTX 50', capability: '12.0' }
  if (/RTX\s*40\d{2}|RTX\s*\d{4}\s*ADA|L40|L4\b/.test(n)) return { family: 'ada', series: 'RTX 40', capability: '8.9' }
  if (/RTX\s*30\d{2}|RTX\s*A\d{3,4}|\bA(10|30|40|100)\b/.test(n)) return { family: 'ampere', series: 'RTX 30', capability: '8.6' }
  if (/RTX\s*20\d{2}|TITAN\s*RTX|QUADRO\s*RTX|GTX\s*16\d{2}|\bT4\b/.test(n)) return { family: 'turing', series: /GTX/.test(n) ? 'GTX 16' : 'RTX 20', capability: '7.5' }
  if (/GTX\s*10\d{2}|TITAN\s*X|P\d{3,4}\b/.test(n)) return { family: 'pascal', series: 'GTX 10', capability: '6.1' }
  if (/GTX|GT\s*\d|QUADRO|TESLA|TITAN/.test(n)) return { family: 'older-nvidia', series: null, capability: null }
  return { family: 'unknown', series: null, capability: null }
}

export function precisionsFor(family: GpuFamily, capability: string | null): Precisions {
  const cc = capability ? Number(capability) : null
  switch (family) {
    case 'blackwell': return { fp16: true, bf16: true, fp8: true, fp4: true }
    case 'ada': return { fp16: true, bf16: true, fp8: true, fp4: false }
    case 'ampere': return { fp16: true, bf16: true, fp8: false, fp4: false }
    // Turing computes fp16 well but has no native bf16: ComfyUI falls back, which is slower and uses more memory.
    case 'turing': return { fp16: true, bf16: false, fp8: false, fp4: false }
    case 'pascal': return { fp16: false, bf16: false, fp8: false, fp4: false }
    case 'rdna': case 'intel-arc': return { fp16: true, bf16: false, fp8: false, fp4: false }
    default: return { fp16: cc !== null && cc >= 7, bf16: cc !== null && cc >= 8, fp8: cc !== null && cc >= 8.9, fp4: cc !== null && cc >= 10 }
  }
}

export interface NvidiaRow {
  name: string
  memoryMiB: number | null
  driver: string | null
  capability: string | null
}

/** One line of `nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader,nounits`. */
export function parseNvidiaSmiRow(line: string): NvidiaRow | null {
  const parts = line.split(',').map((s) => s.trim())
  if (!parts[0]) return null
  const mem = Number(parts[1])
  const cap = parts[3] && /^\d+\.\d+$/.test(parts[3]) ? parts[3] : null
  return { name: parts[0], memoryMiB: Number.isFinite(mem) && mem > 0 ? mem : null, driver: parts[2] && !/n\/a/i.test(parts[2]) ? parts[2] : null, capability: cap }
}

/** "CUDA Version: 12.8" from the header of plain `nvidia-smi` output. */
export function parseCudaDriver(text: string): string | null {
  const m = /CUDA Version:\s*(\d+\.\d+)/i.exec(text)
  return m ? m[1]! : null
}

// ---- memory and tier ----------------------------------------------------------------------------------------------------------------

export function modelMemory(primary: GpuInfo | null, ramGB: number): { gb: number | null; note: string } {
  if (!primary) return { gb: null, note: 'No graphics card Atlas can use was found, so models would run on the processor (very slow) or in the cloud.' }
  if (primary.memoryKind === 'unified') {
    // One pool shared by the processor and the graphics chip: leave room for Windows and Atlas.
    const gb = Math.max(4, Math.min(ramGB * 0.75, ramGB - 12))
    return { gb: round1(gb), note: `Unified memory: this computer's ${round1(ramGB)} GB is shared by the processor and the graphics chip, so models can use about ${round1(gb)} GB of it (the rest is kept for Windows and your programs).` }
  }
  if (primary.memoryKind === 'shared') {
    const gb = Math.min(8, ramGB * 0.35)
    return { gb: round1(gb), note: `Shared memory: the integrated graphics borrows from the computer's ${round1(ramGB)} GB. Models can use roughly ${round1(gb)} GB and run slowly.` }
  }
  return { gb: primary.vramGB, note: `Dedicated graphics memory: ${primary.vramGB ?? '?'} GB on the card. Models larger than that are split with the computer's ${round1(ramGB)} GB and run more slowly.` }
}

export function tierFor(modelMemoryGB: number | null): Tier {
  if (modelMemoryGB === null || modelMemoryGB < 3) return 'none'
  if (modelMemoryGB < 6) return 'entry'
  if (modelMemoryGB < 12) return 'mainstream'
  if (modelMemoryGB < 24) return 'high'
  return 'workstation'
}


// ---- what the runtime can do on this computer ---------------------------------------------------------------------------------------------

export function assessRuntime(p: Pick<HardwareProfile, 'os' | 'arch' | 'appArch' | 'emulated' | 'primary'>): RuntimeCompat {
  const notes: string[] = []
  const gpu = p.primary
  if (p.os.platform !== 'win32') {
    return { managedComfy: 'unsupported', managedComfyReason: 'Atlas installs its own ComfyUI on Windows only. Install ComfyUI yourself and connect it.', connectComfy: 'supported', notes: ['A ComfyUI running on this or another computer can be connected from the Studio settings.'] }
  }
  if (p.arch === 'arm64') {
    notes.push('This is a Windows-on-Arm computer. Programs built for x64 (Python, CUDA packages, the ComfyUI portable builds) run only in emulation or not at all, so Atlas does not install them here.')
    notes.push('Follow ComfyUI\'s official instructions for Windows on Arm (a native Arm64 Python with the PyTorch build NVIDIA provides for this platform), or run ComfyUI on another computer and connect to it over the network.')
    if (p.emulated) notes.push('Atlas itself is running as an x64 program under emulation. Its image search model uses the processor, which is slower than on a native x64 computer.')
    return {
      managedComfy: 'unsupported',
      managedComfyReason: 'ComfyUI has no official portable build for Windows on Arm, and x64 Python with CUDA does not run unchanged there. Atlas will not install it; use the official instructions, then connect it.',
      connectComfy: gpu?.vendor === 'nvidia' ? 'untested' : 'untested',
      notes
    }
  }
  if (p.arch !== 'x64') return { managedComfy: 'unsupported', managedComfyReason: 'This processor architecture is not supported by the ComfyUI builds Atlas installs.', connectComfy: 'untested', notes }
  if (!gpu) return { managedComfy: 'unsupported', managedComfyReason: 'No graphics card was found. Use a cloud image service, or connect a ComfyUI that runs on another computer.', connectComfy: 'supported', notes }
  if (gpu.vendor === 'nvidia') {
    const driver = gpu.driver ? Number(gpu.driver.split('.')[0]) : null
    if (gpu.family === 'blackwell') {
      notes.push('RTX 50-series cards need a ComfyUI build with PyTorch for CUDA 12.8 or newer and an NVIDIA driver 570 or newer. The current portable build includes it; an old ComfyUI or driver will not work.')
      if (driver !== null && driver < 570) return { managedComfy: 'untested', managedComfyReason: `The graphics driver (${gpu.driver}) is older than 570, which RTX 50-series cards need. Update the NVIDIA driver first.`, connectComfy: 'untested', notes }
      return { managedComfy: 'untested', managedComfyReason: 'The portable ComfyUI Atlas installs supports RTX 50-series cards in principle, but Atlas has not been tested on one.', connectComfy: 'untested', notes }
    }
    if (gpu.family === 'pascal' || gpu.family === 'older-nvidia') {
      notes.push('Cards older than the RTX 20 series have no fast half-precision maths, so most current models run very slowly or not at all.')
      return { managedComfy: 'untested', managedComfyReason: 'This card is older than the RTX 20 series. ComfyUI starts, but models run slowly.', connectComfy: 'untested', notes }
    }
    return { managedComfy: 'supported', managedComfyReason: 'The portable ComfyUI for NVIDIA cards works with this card.', connectComfy: 'supported', notes }
  }
  if (gpu.vendor === 'amd') return { managedComfy: 'untested', managedComfyReason: 'Atlas can install the AMD build of ComfyUI, but support is newer and slower than NVIDIA and Atlas has not been tested on AMD graphics.', connectComfy: 'untested', notes }
  if (gpu.vendor === 'intel') return { managedComfy: 'untested', managedComfyReason: 'Atlas can install the Intel build of ComfyUI, but it is slow and Atlas has not been tested on Intel graphics.', connectComfy: 'untested', notes }
  return { managedComfy: 'unsupported', managedComfyReason: 'Atlas does not know how to run models on this graphics hardware.', connectComfy: 'untested', notes }
}

// ---- assembling a profile -------------------------------------------------------------------------------------------------------------------------

export interface RawHardware {
  platform: string
  release: string
  windowsBuild: number | null
  arch: Arch
  appArch: Arch
  cpuName: string
  cores: number
  ramBytes: number
  /** Each graphics adapter as the system reports it. */
  adapters: Array<{ name: string; vendor?: GpuInfo['vendor']; memoryMiB?: number | null; driver?: string | null; capability?: string | null; cudaDriver?: string | null; integrated?: boolean }>
}

function vendorOf(name: string): GpuInfo['vendor'] {
  return /nvidia|geforce|quadro|tesla|rtx|gtx/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'other'
}

export function buildProfile(raw: RawHardware, simulated: string | null = null): HardwareProfile {
  const ramGB = round1(raw.ramBytes / GB)
  const gpus: GpuInfo[] = raw.adapters.map((a): GpuInfo => {
    const vendor = a.vendor ?? vendorOf(a.name)
    let family: GpuFamily = 'unknown'
    let series: string | null = null
    let capability = a.capability ?? null
    if (vendor === 'nvidia') {
      const inf = inferNvidia(a.name)
      family = inf.family
      series = inf.series
      capability = capability ?? inf.capability
    } else if (vendor === 'amd') family = /RX\s*[5-9]\d{3}/i.test(a.name) ? 'rdna' : 'unknown'
    else if (vendor === 'intel') family = /arc/i.test(a.name) ? 'intel-arc' : 'integrated'
    const unified = vendor === 'nvidia' && (family === 'blackwell' && raw.arch === 'arm64') || /spark|gb10/i.test(a.name)
    const integrated = a.integrated || (vendor === 'intel' && family === 'integrated') || (vendor === 'amd' && /graphics$/i.test(a.name))
    const memoryKind: MemoryKind = unified ? 'unified' : integrated ? 'shared' : a.memoryMiB ? 'dedicated' : 'none'
    return {
      name: a.name,
      vendor,
      family,
      series,
      computeCapability: capability,
      vramGB: memoryKind === 'dedicated' && a.memoryMiB ? round1(a.memoryMiB / 1024) : null,
      memoryKind,
      driver: a.driver ?? null,
      cudaDriver: a.cudaDriver ?? null
    }
  })
  // The most capable adapter is the one models run on: NVIDIA first, then by memory.
  const score = (g: GpuInfo): number => (g.vendor === 'nvidia' ? 1000 : g.vendor === 'amd' ? 500 : 100) + (g.memoryKind === 'unified' ? 400 : 0) + (g.vramGB ?? 0)
  const primary = [...gpus].filter((g) => g.memoryKind !== 'none' || g.vendor === 'nvidia').sort((a, b) => score(b) - score(a))[0] ?? null
  const mem = modelMemory(primary, ramGB)
  const profile: HardwareProfile = {
    simulated,
    os: { platform: raw.platform, release: raw.release, windowsBuild: raw.windowsBuild },
    arch: raw.arch,
    appArch: raw.appArch,
    emulated: raw.arch !== raw.appArch,
    cpu: { name: raw.cpuName, cores: raw.cores },
    ramGB,
    gpus,
    primary,
    modelMemoryGB: mem.gb,
    memoryNote: mem.note,
    precisions: primary ? precisionsFor(primary.family, primary.computeCapability) : { fp16: false, bf16: false, fp8: false, fp4: false },
    tier: tierFor(mem.gb),
    runtime: { managedComfy: 'unsupported', managedComfyReason: '', connectComfy: 'untested', notes: [] }
  }
  profile.runtime = assessRuntime(profile)
  return profile
}

// ---- reading the real computer -----------------------------------------------------------------------------------------------------------------

const run = (file: string, args: string[], timeout = 6000): Promise<string> =>
  new Promise((resolveRun) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => resolveRun(error ? '' : String(stdout)))
  })

const archOf = (value: string): Arch => (/arm64|aarch64/i.test(value) ? 'arm64' : /amd64|x64|x86_64/i.test(value) ? 'x64' : 'other')

export interface DetectDeps {
  run?: typeof run
  platform?: string
  processArch?: string
  env?: Record<string, string | undefined>
  totalmem?: number
  cpu?: { name: string; cores: number }
  release?: string
}

export async function detectProfile(deps: DetectDeps = {}): Promise<HardwareProfile> {
  const exec = deps.run ?? run
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const appArch = archOf(deps.processArch ?? process.arch)
  let arch: Arch = appArch
  if (platform === 'win32') {
    // A x64 program on a Windows-on-Arm computer reports x64 for itself; the processor tells the truth.
    const native = archOf(env['PROCESSOR_ARCHITEW6432'] ?? '')
    if (native !== 'other') arch = native
    else {
      const wmi = (await exec('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture'])).trim()
      if (wmi === '12') arch = 'arm64'
      else if (wmi === '9') arch = 'x64'
    }
  }
  const cpus = os.cpus()
  const cpu = deps.cpu ?? { name: (cpus[0]?.model ?? 'Unknown processor').trim(), cores: cpus.length }
  const release = deps.release ?? os.release()
  const build = platform === 'win32' ? Number(release.split('.')[2]) || null : null
  const adapters: RawHardware['adapters'] = []
  if (platform === 'win32' || platform === 'linux') {
    const smi = (await exec('nvidia-smi', ['--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader,nounits'])).trim() || (await exec('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'])).trim()
    const cuda = parseCudaDriver(await exec('nvidia-smi', []))
    for (const line of smi.split(/\r?\n/).filter(Boolean)) {
      const row = parseNvidiaSmiRow(line)
      if (row) adapters.push({ name: row.name, vendor: 'nvidia', memoryMiB: row.memoryMiB, driver: row.driver, capability: row.capability, cudaDriver: cuda })
    }
    if (platform === 'win32') {
      const names = (await exec('powershell.exe', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name -join "|"'])).trim().split('|').filter(Boolean)
      for (const n of names) if (!adapters.some((a) => a.name === n) && !/nvidia|microsoft basic|remote display/i.test(n)) adapters.push({ name: n, integrated: /intel(?!.*arc)|graphics$/i.test(n) && !/arc/i.test(n) })
    }
  }
  return buildProfile({ platform, release, windowsBuild: build, arch, appArch, cpuName: cpu.name, cores: cpu.cores, ramBytes: deps.totalmem ?? os.totalmem(), adapters })
}

// ---- simulated computers (previews, and tests) ------------------------------------------------------------------------------------------------------------------

/** Computers other than this one, for "what would Atlas recommend there". They are never reported as real. */
export const SIMULATED: Record<string, { label: string; raw: RawHardware }> = {
  'rtx-2080': { label: 'RTX 2080, 8 GB (Windows x64)', raw: { platform: 'win32', release: '10.0.26100', windowsBuild: 26100, arch: 'x64', appArch: 'x64', cpuName: 'Typical 8-core x64 processor', cores: 16, ramBytes: 32 * GB, adapters: [{ name: 'NVIDIA GeForce RTX 2080', vendor: 'nvidia', memoryMiB: 8192, driver: '576.80', capability: '7.5', cudaDriver: '12.9' }] } },
  'rtx-3060': { label: 'RTX 3060, 12 GB (Windows x64)', raw: { platform: 'win32', release: '10.0.26100', windowsBuild: 26100, arch: 'x64', appArch: 'x64', cpuName: 'Typical 6-core x64 processor', cores: 12, ramBytes: 16 * GB, adapters: [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', memoryMiB: 12288, driver: '576.80', capability: '8.6', cudaDriver: '12.9' }] } },
  'rtx-4090': { label: 'RTX 4090, 24 GB (Windows x64)', raw: { platform: 'win32', release: '10.0.26100', windowsBuild: 26100, arch: 'x64', appArch: 'x64', cpuName: 'Typical 16-core x64 processor', cores: 32, ramBytes: 64 * GB, adapters: [{ name: 'NVIDIA GeForce RTX 4090', vendor: 'nvidia', memoryMiB: 24564, driver: '576.80', capability: '8.9', cudaDriver: '12.9' }] } },
  'rtx-5080': { label: 'RTX 5080, 16 GB (Windows x64)', raw: { platform: 'win32', release: '10.0.26100', windowsBuild: 26100, arch: 'x64', appArch: 'x64', cpuName: 'Typical 12-core x64 processor', cores: 24, ramBytes: 32 * GB, adapters: [{ name: 'NVIDIA GeForce RTX 5080', vendor: 'nvidia', memoryMiB: 16303, driver: '576.80', capability: '12.0', cudaDriver: '12.9' }] } },
  'rtx-5090': { label: 'RTX 5090, 32 GB (Windows x64)', raw: { platform: 'win32', release: '10.0.26100', windowsBuild: 26100, arch: 'x64', appArch: 'x64', cpuName: 'Typical 16-core x64 processor', cores: 32, ramBytes: 64 * GB, adapters: [{ name: 'NVIDIA GeForce RTX 5090', vendor: 'nvidia', memoryMiB: 32607, driver: '576.80', capability: '12.0', cudaDriver: '12.9' }] } },
  'rtx-spark-arm64': { label: 'RTX Spark, Windows on Arm64, 128 GB unified memory', raw: { platform: 'win32', release: '10.0.26100', windowsBuild: 26100, arch: 'arm64', appArch: 'arm64', cpuName: 'NVIDIA Arm64 processor (assumed)', cores: 20, ramBytes: 128 * GB, adapters: [{ name: 'NVIDIA RTX Spark', vendor: 'nvidia', memoryMiB: null, driver: null, capability: '12.1', cudaDriver: null }] } },
  'rtx-spark-arm64-emulated': { label: 'RTX Spark, Windows on Arm64, Atlas running as x64 (emulated)', raw: { platform: 'win32', release: '10.0.26100', windowsBuild: 26100, arch: 'arm64', appArch: 'x64', cpuName: 'NVIDIA Arm64 processor (assumed)', cores: 20, ramBytes: 128 * GB, adapters: [{ name: 'NVIDIA RTX Spark', vendor: 'nvidia', memoryMiB: null, driver: null, capability: '12.1', cudaDriver: null }] } },
  'amd-rx-7800': { label: 'AMD Radeon RX 7800 XT, 16 GB (Windows x64)', raw: { platform: 'win32', release: '10.0.26100', windowsBuild: 26100, arch: 'x64', appArch: 'x64', cpuName: 'Typical 8-core x64 processor', cores: 16, ramBytes: 32 * GB, adapters: [{ name: 'AMD Radeon RX 7800 XT', vendor: 'amd', memoryMiB: 16384 }] } },
  'no-gpu': { label: 'No dedicated graphics (integrated only)', raw: { platform: 'win32', release: '10.0.26100', windowsBuild: 26100, arch: 'x64', appArch: 'x64', cpuName: 'Typical 4-core x64 processor', cores: 8, ramBytes: 16 * GB, adapters: [{ name: 'Intel(R) UHD Graphics', vendor: 'intel', integrated: true }] } }
}

export function simulatedProfile(id: string): HardwareProfile | null {
  const entry = SIMULATED[id]
  return entry ? buildProfile(entry.raw, id) : null
}
