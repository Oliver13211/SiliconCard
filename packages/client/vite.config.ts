import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * M1-INF4：站点部署在 GitHub Pages 项目页 https://oliver13211.github.io/SiliconCard/，
 * 资源必须带 /SiliconCard/ 前缀。这里选相对 base（'./'）而非硬编码 '/SiliconCard/'：
 * - 构建产物不绑定部署子路径——仓库改名、自定义域名或换子路径托管时零改动；
 * - index.html 中的 ./assets/... 在 /SiliconCard/ 下正确解析到 /SiliconCard/assets/...；
 * - dev server（yarn dev）不受 base 影响，仍在根路径服务。
 * 前提：应用不依赖 history 深链路由（当前为主菜单 + 对局的 SPA，无多级路由），满足。
 */
export default defineConfig({
  base: './',
  plugins: [react()],
})
