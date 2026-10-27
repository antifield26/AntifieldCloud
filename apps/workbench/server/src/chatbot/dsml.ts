/**
 * 模型原始工具调用文本的清洗。
 *
 * 背景：部分模型/网关在工具调用未被正确解析时，会把内部标记作为普通 assistant 文本返回，例如
 * `<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="botmsg_send_message"> ...`。这属于内部协议语法，
 * 不能发送给 QQ 用户，也不能写入长期记忆；但其中的 `parameter name="text"` 往往是模型本来想发送的正文，
 * 可以在识别后提取出来作为兜底回复，避免“用户收不到回复”。
 *
 * 安全边界：只处理模型输出中的已知 DSML/工具调用标记；不解析 turn_token、不执行任何工具、不改变权限判断。
 */

const DSML_TAG = '[｜|]{1,2}DSML[｜|]{1,2}'

function fullBlockPattern(): RegExp {
  // 从首个工具调用开始到最后一个闭合标签，整段移除；避免只删掉第一个 parameter 后残留 turn_token/id。
  return new RegExp(`<${DSML_TAG}[\\s\\S]*<\\/${DSML_TAG}[^>]*>`, 'gi')
}

function textParameterPattern(): RegExp {
  return new RegExp(
    `<${DSML_TAG}\\s*parameter\\s+name=["']text["'][^>]*>([\\s\\S]*?)<\\/${DSML_TAG}\\s*parameter\\s*>`,
    'gi',
  )
}

function anyTagPattern(): RegExp {
  return new RegExp(`<\\/?${DSML_TAG}[^>]*>`, 'gi')
}

function unclosedTailPattern(): RegExp {
  return new RegExp(`<${DSML_TAG}[\\s\\S]*$`, 'gi')
}

/** 是否为模型原始工具调用文本（含 DSML 标记或旧式 `<|DSML|>` 标记）。 */
export function hasRawToolCallText(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  return new RegExp(DSML_TAG, 'i').test(value) || /<\|DSML\|>/i.test(value)
}

/** 提取原始工具调用中的 `parameter name="text"` 正文；仅返回模型本来要发送的可读文本。 */
export function extractRawToolCallText(value: string): { detected: boolean; text: string } {
  if (!hasRawToolCallText(value)) return { detected: false, text: '' }
  const pieces: string[] = []
  for (const match of value.matchAll(textParameterPattern())) {
    const cleaned = (match[1] ?? '')
      .replace(anyTagPattern(), '')
      .replace(/\r\n?/g, '\n')
      .trim()
    if (cleaned) pieces.push(cleaned)
  }
  return { detected: true, text: pieces.join('\n').trim() }
}

/** 删除原始工具调用标记与参数块，保留非工具调用的普通文本。 */
export function stripRawToolCallText(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return value
  return value
    .replace(fullBlockPattern(), '')
    .replace(anyTagPattern(), '')
    .replace(unclosedTailPattern(), '')
    .replace(/<\|DSML\|>[\s\S]*?<\/\|DSML\|>/gi, '')
    .replace(/<\/?\|DSML\|>/gi, '')
    .trim()
}
