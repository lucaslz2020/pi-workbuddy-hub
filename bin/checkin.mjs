#!/usr/bin/env node
/**
 * wb-checkin —— 不依赖 pi 进程的批量签到，专给 launchd / cron 用。
 *
 * 为什么单独一个 CLI：pi 的扩展只在 session 里跑，定时签到不该要求「先开着 pi」。
 * 批量逻辑放在 `src/runner.ts`，扩展和 CLI 共用同一份代码，行为就不会分叉
 * —— 这个文件只做三件事：解析参数、排版、决定退出码。
 *
 * 用法：
 *   wb-checkin                # 全部账号签到一次
 *   wb-checkin --dry-run      # 只查状态（完全不 POST 领奖）
 *   wb-checkin --json         # 机器可读输出，给定时任务日志用
 *   wb-checkin --only <昵称>  # 只跑匹配的账号
 *   wb-checkin --concurrency 2
 *
 * 退出码：0 = 全部「有结论」（含今日已签、活动未开启）；1 = 有失败或需重登。
 * 定时任务要「只在真出问题时报警」，看这个码就够了。
 */

import { findAccounts, listAccounts, prepareAccounts } from '../src/accounts.ts'
import { displayContext, pad, resolveMaskLevel } from '../src/mask.ts'
import { beijingDay } from '../src/time.ts'
import { outcomeIcon, regionLabel } from '../src/view.ts'
import { needsAttention, probeMany, runMany, summarize, totalCredit } from '../src/runner.ts'

const USAGE = `wb-checkin — 多账号 WorkBuddy 每日签到

  wb-checkin                  全部账号签到（幂等）
  wb-checkin --dry-run        只查状态，不发领奖请求
  wb-checkin --json           输出 JSON（给定时任务日志）
  wb-checkin --no-mask        显示账号真名（默认在管道/日志里自动脱敏）
  wb-checkin --only <id|标签> 只处理匹配的账号
  wb-checkin -c <n>           账号间并发度（默认 3）
  wb-checkin --help

退出码：0 全部有结论 / 1 有失败或需重新登录
签到日按北京时间（UTC+8）划分。`

const NAME_WIDTH = 18

/** 解析命令行。只认长选项与 `-c/-n/-h`，未知参数忽略（launchd 常带多余参数）。 */
function parseArgs(argv) {
  const options = { dryRun: false, json: false, only: undefined, concurrency: 3, help: false, noMask: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run' || arg === '-n') options.dryRun = true
    else if (arg === '--no-mask') options.noMask = true
    else if (arg === '--json') options.json = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--only') options.only = argv[++i]
    else if (arg === '--concurrency' || arg === '-c') options.concurrency = Number(argv[++i]) || 3
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length)
    else if (arg.startsWith('--concurrency=')) options.concurrency = Number(arg.slice('--concurrency='.length)) || 3
  }
  return options
}

/** 只查不领：一行一个账号的今日状态。 */
async function runDryRun(selected, ui, options, day) {
  const probes = await probeMany(selected, { concurrency: options.concurrency })
  const rows = probes.map(({ account, status, error }) => ({
    id: account.id,
    label: ui.name(account),
    region: account.region,
    ...(error === undefined
      ? {
          active: status?.active,
          todayCheckedIn: status?.todayCheckedIn,
          streakDays: status?.streakDays,
          todayCredit: status?.todayCredit,
        }
      : { error: ui.scrub(error) }),
  }))

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ day, dryRun: true, accounts: rows }, null, 2)}\n`)
  } else {
    process.stdout.write(`多账号 WorkBuddy 签到状态（${day}，北京时区）— 未发任何领奖请求\n\n`)
    for (const row of rows) {
      if (row.error !== undefined) {
        process.stdout.write(`${outcomeIcon('failed')} ${pad(row.label, NAME_WIDTH)} ${row.error}\n`)
        continue
      }
      const state = row.active
        ? (row.todayCheckedIn
            ? `今日已签${row.streakDays === undefined ? '' : `（连签 ${row.streakDays} 天）`}`
            : '今日未签')
        : '无进行中的活动'
      process.stdout.write(
        `${outcomeIcon(row.active && row.todayCheckedIn ? 'done' : 'inactive')} `
        + `${pad(row.label, NAME_WIDTH)} ${pad(regionLabel(row.region), 7)} ${state}\n`,
      )
    }
  }
  return rows.some(row => row.error !== undefined) ? 1 : 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  // 加密的桌面端凭据要靠 at-rest 密钥；拿不到不影响明文来源
  await prepareAccounts()

  const all = listAccounts()
  if (all.length === 0) {
    process.stderr.write(
      '没有找到任何 WorkBuddy 账号。\n'
      + '  · 先登录桌面端 WorkBuddy，然后运行 pi 里的 /wb sync\n'
      + '  · 或用 pi 登录 provider：/login workbuddy\n'
      + '  · 或手动添加：/wb add <token>\n',
    )
    return 1
  }

  const selected = options.only === undefined ? all : findAccounts(all, options.only)
  if (selected.length === 0) {
    process.stderr.write(`没有账号匹配 --only "${options.only}"。可用账号：\n`)
    for (const account of all) process.stderr.write(`  ${account.id}  ${account.label}\n`)
    return 1
  }

  const day = beijingDay()
  // 非 TTY（管道/日志/CI）默认脱敏；--no-mask 或 WORKBUDDY_MASK=full 可关
  const ctx = displayContext(options.noMask ? 'full' : resolveMaskLevel(), selected)

  if (options.dryRun) return runDryRun(selected, ctx, options, day)

  const results = await runMany(selected, {
    concurrency: options.concurrency,
    onProgress: options.json
      ? undefined
      : result => {
          process.stdout.write(
            `${outcomeIcon(result.outcome)} ${pad(ctx.name(result.account), NAME_WIDTH)} ${ctx.scrub(result.message)}\n`,
          )
        },
  })

  const gained = totalCredit(results)
  const bad = results.filter(needsAttention).length

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      day,
      summary: summarize(results),
      gained,
      failures: bad,
      accounts: results.map(result => ({
        id: result.account.id,
        label: ctx.name(result.account),
        region: result.account.region,
        outcome: result.outcome,
        credit: result.credit,
        streakDays: result.streakDays,
        daysLeft: result.daysLeft,
        refreshed: result.refreshed,
        message: ctx.scrub(result.message),
      })),
    }, null, 2)}\n`)
  } else {
    process.stdout.write(`\n${summarize(results)}`)
    if (gained > 0) process.stdout.write(`，本次合计 +${gained} 积分`)
    process.stdout.write('\n')
  }

  return bad > 0 ? 1 : 0
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    process.stderr.write(`wb-checkin 出错：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
