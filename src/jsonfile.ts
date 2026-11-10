/**
 * 状态文件的读写层（账号记录、故障冷却、auth.json 共用）。
 *
 * 这三处以前各写了一遍同样的三件事：
 *   1. 读坏了当空对象，绝不让一个坏文件拖垮整批；
 *   2. 先写 `.tmp` 再 rename，半写文件不会出现；
 *   3. 覆盖别人的文件前留一份备份（auth.json 是 pi 自己也会写的）。
 *
 * 现在只有这一个实现。任何一个模块都不该再自己 `JSON.parse(readFileSync(...))`。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读一个 JSON 对象文件。文件不存在、读不了、不是对象，一律返回空对象 ——
 * 状态文件是「方便下次展示」用的，读不到不该打断当前操作。
 */
export function readJsonObject<T = Record<string, unknown>>(path: string): T {
  if (!existsSync(path)) return {} as T
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return (isPlainObject(parsed) ? parsed : {}) as T
  } catch {
    return {} as T
  }
}

export interface WriteOptions {
  /** 覆盖前把原文件复制成 `<path>.bak-<时间戳>`；返回该路径（没备份就没有）。 */
  backup?: boolean
}

/**
 * 原子写一个 JSON 文件（2 空格缩进 + 结尾换行，与 pi 亲手写的格式一致）。
 * 失败时抛错，由调用方决定是「报给人看」还是「默默算了」。
 */
export function writeJsonAtomic(path: string, value: unknown, options: WriteOptions = {}): string | undefined {
  const body = `${JSON.stringify(value, null, 2)}\n`
  mkdirSync(dirname(path), { recursive: true })

  let backupPath: string | undefined
  if (options.backup === true && existsSync(path)) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = `${path}.bak-${stamp}`
      writeFileSync(backupPath, readFileSync(path, 'utf8'), 'utf8')
    } catch {
      backupPath = undefined
    }
  }

  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, path)
  } catch {
    // rename 失败（跨设备/权限）时退回直接写，至少别把内容丢掉
    writeFileSync(path, body, 'utf8')
  }
  return backupPath
}

/** 试着写，写不进去就算了 —— 只读数据目录不该让签到/换号本身失败。 */
export function writeJsonQuietly(path: string, value: unknown, options: WriteOptions = {}): string | undefined {
  try {
    return writeJsonAtomic(path, value, options)
  } catch {
    return undefined
  }
}
