/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PITCH_DEBUG?: string
  readonly VITE_ENABLE_ASYNC_TRANSITION?: string
  readonly VITE_USE_TARGET_NOTE?: string
  readonly VITE_PITCH_DETECTOR?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}


