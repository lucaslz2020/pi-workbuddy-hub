/**
 * 清除本地凭据：provider 自己的刷新副本 + 该区域的 OAuth vault。
 * 桌面端 App 的 auth 文件**永不**触碰。
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { workbuddyDataDir } from '../accounts.ts'
import type { Region } from '../upstream.ts'

export function clearStoredCredentials(region: Region): void {
  const dir = workbuddyDataDir()
  for (const path of [join(dir, `auth.${region}.json`), join(dir, 'workbuddy-vault', region)]) {
    try {
      if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    } catch {
      // 尽力而为：下次刷新本来就会覆盖
    }
  }
}
