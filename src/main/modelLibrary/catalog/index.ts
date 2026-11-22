// Built-in catalogue entries. Each is a data file; add a new one here, or (without rebuilding Atlas) put a .json file in the
// model-library folder of Atlas's data folder.
import e0 from './sd15-base.json'
import e1 from './sd15-tile-controlnet.json'
import e2 from './realesrgan-x4plus.json'
import e3 from './flux2-klein-4b.json'
import e4 from './flux2-klein-9b.json'
import e5 from './krea2-turbo.json'
import e6 from './realvisxl-v4.json'
import e7 from './siglip-base-patch16-224.json'
import e8 from './ollama-moondream.json'
import e9 from './ollama-gemma3-4b.json'
import e10 from './ollama-qwen25vl-7b.json'

export const BUILT_IN: unknown[] = [e0, e1, e2, e3, e4, e5, e6, e7, e8, e9, e10]
