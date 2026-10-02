// 二维码编码(字节模式, 纠错等级可选) —— 供 AppPage 把网易云扫码登录页 URL 画成二维码。
//
// 后端只给 `qr_content`(登录页 URL, 见 `src/netease.rs` 的 `qr_create`: "wasm 里没有
// 二维码渲染依赖, 前端自己画"), 宿主又禁止插件 UI 直接 fetch, 所以这里自带一个
// 纯 TS 的 QR Model 2 编码器(不引新依赖, 也不能引: 构建复用 music-dl 的 node_modules)。
//
// 算法与常量表按 ISO/IEC 18004 实现, 结构参照 Project Nayuki 的 QR Code generator
// (MIT License, https://www.nayuki.io/page/qr-code-generator-library) 的 TypeScript 版
// 移植改写: 只保留字节模式 + 单一纠错等级, 去掉字符模式与分段 API。
//
// Copyright (c) Project Nayuki. (MIT License)
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions:
// - The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
// - The Software is provided "as is", without warranty of any kind, express or
//   implied, including but not limited to the warranties of merchantability,
//   fitness for a particular purpose and noninfringement. In no event shall the
//   authors or copyright holders be liable for any claim, damages or other
//   liability, whether in an action of contract, tort or otherwise, arising from,
//   out of or in connection with the Software or the use or other dealings in
//   the Software.

export type EccLevel = 'L' | 'M' | 'Q' | 'H'

/** 纠错等级 → 表行序(与 nayuki 的 `Ecc.ordinal` 一致)。 */
const ECC_ORDINAL: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 }
/** 纠错等级 → 格式信息里的 2 bit(ISO/IEC 18004 表 25: L=01, M=00, Q=11, H=10)。 */
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 }

const MIN_VERSION = 1
const MAX_VERSION = 40
const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

// 每个纠错块的纠错码字数(行 = 纠错等级, 列 = 版本; 索引 0 是占位)。
const ECC_CODEWORDS_PER_BLOCK: readonly number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]

// 纠错块数(行 = 纠错等级, 列 = 版本; 索引 0 是占位)。
const NUM_ERROR_CORRECTION_BLOCKS: readonly number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

/** 版本号 → 该版本里可用的数据位数(不含函数图形, 含 remainder bits)。 */
function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** 版本 + 纠错等级 → 数据码字数(总码字数减去纠错码字)。 */
function numDataCodewords(version: number, ordinal: number): number {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ordinal][version] * NUM_ERROR_CORRECTION_BLOCKS[ordinal][version]
  )
}

/** 字节模式的字符计数指示符位数(版本 1-9 是 8 位, 10-40 是 16 位)。 */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16
}

function utf8Bytes(text: string): number[] {
  const out: number[] = []
  for (const byte of new TextEncoder().encode(text)) out.push(byte)
  return out
}

function getBit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

/** GF(2^8/0x11D) 上的乘法(俄农乘法)。 */
function reedSolomonMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** 生成多项式 (x - r^0)(x - r^1)...(x - r^{degree-1}) 的系数(最高次项恒为 1, 省略)。 */
function reedSolomonComputeDivisor(degree: number): number[] {
  const result: number[] = []
  for (let i = 0; i < degree - 1; i++) result.push(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = reedSolomonMultiply(root, 0x02)
  }
  return result
}

function reedSolomonComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i] ^= reedSolomonMultiply(coef, factor)
    })
  }
  return result
}

/** 一份二维码符号: 模块矩阵(false = 浅色, true = 深色)。 */
export interface QrCode {
  /** 边长(模块数, 21-177)。 */
  size: number
  /** 实际使用的掩码编号 0-7。 */
  mask: number
  /** 版本号 1-40。 */
  version: number
  /** `modules[y][x]`。 */
  modules: boolean[][]
}

/**
 * 把文本编成二维码(字节模式 + UTF-8)。内容超出 40 版容量时抛错。
 *
 * `forceMask` 只给对拍测试用(固定掩码, 跳过自动选掩码), 业务代码不要传。
 */
export function encodeQr(text: string, level: EccLevel = 'M', forceMask?: number): QrCode {
  const ordinal = ECC_ORDINAL[level]
  const bytes = utf8Bytes(text)

  let version = 0
  let usedBits = 0
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const capacityBits = numDataCodewords(v, ordinal) * 8
    const bits = 4 + charCountBits(v) + bytes.length * 8
    if (bits <= capacityBits) {
      version = v
      usedBits = bits
      break
    }
  }
  if (version === 0) throw new Error('内容过长, 超出二维码(版本 40)的容量')

  // 位流: 模式指示符 0100 + 字符计数 + 数据 + 结束符 + 补齐 + 填充码字。
  const bits: number[] = []
  const appendBits = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  appendBits(0b0100, 4)
  appendBits(bytes.length, charCountBits(version))
  for (const b of bytes) appendBits(b, 8)

  const capacityBits = numDataCodewords(version, ordinal) * 8
  appendBits(0, Math.min(4, capacityBits - usedBits))
  appendBits(0, (8 - (bits.length % 8)) % 8)
  for (let padByte = 0xec; bits.length < capacityBits; padByte ^= 0xec ^ 0x11) appendBits(padByte, 8)

  const dataCodewords: number[] = new Array(bits.length / 8).fill(0)
  bits.forEach((bit, i) => {
    dataCodewords[i >>> 3] |= bit << (7 - (i & 7))
  })

  return new QrSymbol(version, ordinal, level, dataCodewords).build(forceMask)
}

class QrSymbol {
  readonly size: number
  private readonly modules: boolean[][] = []
  private readonly isFunction: boolean[][] = []

  constructor(
    readonly version: number,
    private readonly ordinal: number,
    private readonly level: EccLevel,
    private readonly dataCodewords: number[],
  ) {
    this.size = version * 4 + 17
    for (let i = 0; i < this.size; i++) {
      this.modules.push(new Array<boolean>(this.size).fill(false))
      this.isFunction.push(new Array<boolean>(this.size).fill(false))
    }
  }

  build(forceMask?: number): QrCode {
    this.drawFunctionPatterns()
    this.drawCodewords(this.addEccAndInterleave())

    // 自动选掩码: 逐个试 0-7, 取罚分最低的那个(forceMask 则直接用它)。
    let best = forceMask ?? 0
    if (forceMask === undefined) {
      let minPenalty = Number.POSITIVE_INFINITY
      for (let mask = 0; mask < 8; mask++) {
        this.applyMask(mask)
        this.drawFormatBits(mask)
        const penalty = this.penaltyScore()
        if (penalty < minPenalty) {
          best = mask
          minPenalty = penalty
        }
        this.applyMask(mask) // 同样的掩码异或两次即还原
      }
    }
    this.applyMask(best)
    this.drawFormatBits(best)

    return { size: this.size, mask: best, version: this.version, modules: this.modules }
  }

  private setFunctionModule(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark
    this.isFunction[y][x] = true
  }

  private drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0)
      this.setFunctionModule(i, 6, i % 2 === 0)
    }
    this.drawFinderPattern(3, 3)
    this.drawFinderPattern(this.size - 4, 3)
    this.drawFinderPattern(3, this.size - 4)

    const alignPos = this.alignmentPatternPositions()
    const numAlign = alignPos.length
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0))) {
          this.drawAlignmentPattern(alignPos[i], alignPos[j])
        }
      }
    }
    this.drawFormatBits(0) // 占位, build() 里会用真实掩码重画
    this.drawVersion()
  }

  /** 对齐图形中心坐标(版本 1 没有)。 */
  private alignmentPatternPositions(): number[] {
    if (this.version === 1) return []
    const numAlign = Math.floor(this.version / 7) + 2
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
    const result: number[] = [6]
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
    return result
  }

  private drawFinderPattern(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4)
        }
      }
    }
  }

  private drawAlignmentPattern(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  private drawFormatBits(mask: number): void {
    const data = (ECC_FORMAT_BITS[this.level] << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412

    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i))
    this.setFunctionModule(8, 7, getBit(bits, 6))
    this.setFunctionModule(8, 8, getBit(bits, 7))
    this.setFunctionModule(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i))

    for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i))
    this.setFunctionModule(8, this.size - 8, true) // 恒为深色的模块
  }

  private drawVersion(): void {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunctionModule(a, b, color)
      this.setFunctionModule(b, a, color)
    }
  }

  /** 数据码字 → (纠错 + 交错) 后的完整码字序列。 */
  private addEccAndInterleave(): number[] {
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[this.ordinal][this.version]
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[this.ordinal][this.version]
    const rawCodewords = Math.floor(numRawDataModules(this.version) / 8)
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
    const shortBlockLen = Math.floor(rawCodewords / numBlocks)

    const divisor = reedSolomonComputeDivisor(blockEccLen)
    const blocks: number[][] = []
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = this.dataCodewords.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
      k += dat.length
      const ecc = reedSolomonComputeRemainder(dat, divisor)
      if (i < numShortBlocks) dat.push(0)
      blocks.push(dat.concat(ecc))
    }

    const result: number[] = []
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        // 短块多出来的那个 0 是补齐位, 不参与交错
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i])
      })
    }
    return result
  }

  /** 从右下角起之字形把码字铺进非函数模块。 */
  private drawCodewords(data: readonly number[]): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vert : vert
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7))
            i++
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: throw new RangeError('掩码编号越界')
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  /** ISO/IEC 18004 的四个罚分项(N1/N2/N3/N4), 用于挑最优掩码。 */
  private penaltyScore(): number {
    let result = 0

    for (let y = 0; y < this.size; y++) {
      let runColor = false
      let runLen = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let x = 0; x < this.size; x++) {
        if (this.modules[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += PENALTY_N1
          else if (runLen > 5) result++
        } else {
          this.finderPenaltyAddHistory(runLen, history)
          if (!runColor) result += this.finderPenaltyCountPatterns(history) * PENALTY_N3
          runColor = this.modules[y][x]
          runLen = 1
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runLen, history) * PENALTY_N3
    }

    for (let x = 0; x < this.size; x++) {
      let runColor = false
      let runLen = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let y = 0; y < this.size; y++) {
        if (this.modules[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += PENALTY_N1
          else if (runLen > 5) result++
        } else {
          this.finderPenaltyAddHistory(runLen, history)
          if (!runColor) result += this.finderPenaltyCountPatterns(history) * PENALTY_N3
          runColor = this.modules[y][x]
          runLen = 1
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runLen, history) * PENALTY_N3
    }

    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const color = this.modules[y][x]
        if (
          color === this.modules[y][x + 1] &&
          color === this.modules[y + 1][x] &&
          color === this.modules[y + 1][x + 1]
        ) {
          result += PENALTY_N2
        }
      }
    }

    let dark = 0
    for (const row of this.modules) for (const cell of row) if (cell) dark++
    const total = this.size * this.size
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    result += k * PENALTY_N4

    return result
  }

  private finderPenaltyCountPatterns(runHistory: readonly number[]): number {
    const n = runHistory[1]
    const core =
      n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n
    return (
      (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
    )
  }

  private finderPenaltyTerminateAndCount(runColor: boolean, runLen: number, history: number[]): number {
    let length = runLen
    if (runColor) {
      this.finderPenaltyAddHistory(length, history)
      length = 0
    }
    length += this.size // 行尾补上浅色边界
    this.finderPenaltyAddHistory(length, history)
    return this.finderPenaltyCountPatterns(history)
  }

  private finderPenaltyAddHistory(runLen: number, history: number[]): void {
    let length = runLen
    if (history[0] === 0) length += this.size // 行首补上浅色边界
    history.pop()
    history.unshift(length)
  }
}

/**
 * 把二维码矩阵转成 SVG path 数据(每个深色模块一个 1x1 方块的子路径)。
 * 渲染方自己加白底 + quiet zone 边距(推荐 4 模块)。
 */
export function qrSvgPath(code: QrCode): string {
  const parts: string[] = []
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y][x]) parts.push(`M${x} ${y}h1v1h-1z`)
    }
  }
  return parts.join('')
}
