import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': path.resolve('src/main'),
        '@preload': path.resolve('src/preload')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@preload': path.resolve('src/preload')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': path.resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
