// 二维码编码（字节模式，纠错等级可选）—— 供页面把网易云扫码登录页 URL 画成二维码。
//
// 从 plugins/music-rs/frontend/src/qr.ts 逐行移植（TS → 原生 JS，无依赖）：
// 算法与常量表按 ISO/IEC 18004 实现，结构参照 Project Nayuki 的 QR Code generator
// (MIT License, https://www.nayuki.io/page/qr-code-generator-library) 的 TypeScript 版。
//
// Copyright (c) Project Nayuki. (MIT License)

/** 纠错等级 → 表行序（nayuki 的 Ecc.ordinal）。 */
const ECC_ORDINAL = { L: 0, M: 1, Q: 2, H: 3 }
/** 纠错等级 → 格式信息里的 2 bit（ISO/IEC 18004 表 25: L=01, M=00, Q=11, H=10）。 */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 }

const MIN_VERSION = 1
const MAX_VERSION = 40
const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

/** 每个纠错块的纠错码字数（行 = 纠错等级，列 = 版本；索引 0 是占位）。 */
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]

/** 纠错块数（行 = 纠错等级，列 = 版本；索引 0 是占位）。
 *  M 行 v3 = 1 块（ISO/IEC 18004：V3-M 共 70 码字 = 44 数据 + 26 纠错，单块）。 */
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

/** 版本号 → 该版本里可用的数据位数（不含函数图形，含 remainder bits）。 */
function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** 版本 + 纠错等级 → 数据码字数（总码字数减去纠错码字）。 */
function numDataCodewords(version, ordinal) {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ordinal][version] * NUM_ERROR_CORRECTION_BLOCKS[ordinal][version]
  )
}

/** 字节模式的字符计数指示符位数（版本 1-9 是 8 位，10-40 是 16 位）。 */
function charCountBits(version) {
  return version <= 9 ? 8 : 16
}

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0
}

/** GF(2^8/0x11D) 上的乘法（俄农乘法）。 */
function reedSolomonMultiply(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** 生成多项式 (x - r^0)(x - r^1)...(x - r^{degree-1}) 的系数（最高次项恒为 1，省略）。 */
function reedSolomonComputeDivisor(degree) {
  const result = new Array(degree).fill(0)
  result[degree - 1] = 1
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

function reedSolomonComputeRemainder(data, divisor) {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i] ^= reedSolomonMultiply(coef, factor)
    })
  }
  return result
}

/**
 * 把文本编成二维码（字节模式 + UTF-8）。内容超出 40 版容量时抛错。
 * `forceMask` 只给对拍测试用（固定掩码，跳过自动选掩码），业务代码不要传。
 */
export function encodeQr(text, level = 'M', forceMask) {
  const ordinal = ECC_ORDINAL[level]
  const bytes = [...new TextEncoder().encode(text)]

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

  // 位流：模式指示符 0100 + 字符计数 + 数据 + 结束符 + 补齐 + 填充码字。
  const bits = []
  const appendBits = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  appendBits(0b0100, 4)
  appendBits(bytes.length, charCountBits(version))
  for (const b of bytes) appendBits(b, 8)

  const capacityBits = numDataCodewords(version, ordinal) * 8
  appendBits(0, Math.min(4, capacityBits - usedBits))
  appendBits(0, (8 - (bits.length % 8)) % 8)
  for (let padByte = 0xec; bits.length < capacityBits; padByte ^= 0xec ^ 0x11) appendBits(padByte, 8)

  const dataCodewords = new Array(bits.length / 8).fill(0)
  bits.forEach((bit, i) => {
    dataCodewords[i >>> 3] |= bit << (7 - (i & 7))
  })

  return buildSymbol(version, ordinal, level, dataCodewords, forceMask)
}

function buildSymbol(version, ordinal, level, dataCodewords, forceMask) {
  const size = version * 4 + 17
  const modules = []
  const isFunction = []
  for (let i = 0; i < size; i++) {
    modules.push(new Array(size).fill(false))
    isFunction.push(new Array(size).fill(false))
  }

  const setFunctionModule = (x, y, dark) => {
    modules[y][x] = dark
    isFunction[y][x] = true
  }

  const drawFinderPattern = (x, y) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunctionModule(xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }

  const drawAlignmentPattern = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  const drawFormatBits = (mask) => {
    const data = (ECC_FORMAT_BITS[level] << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bitsValue = ((data << 10) | rem) ^ 0x5412

    for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getBit(bitsValue, i))
    setFunctionModule(8, 7, getBit(bitsValue, 6))
    setFunctionModule(8, 8, getBit(bitsValue, 7))
    setFunctionModule(7, 8, getBit(bitsValue, 8))
    for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, getBit(bitsValue, i))

    for (let i = 0; i < 8; i++) setFunctionModule(size - 1 - i, 8, getBit(bitsValue, i))
    for (let i = 8; i < 15; i++) setFunctionModule(8, size - 15 + i, getBit(bitsValue, i))
    setFunctionModule(8, size - 8, true) // 恒为深色的模块
  }

  const drawVersion = () => {
    if (version < 7) return
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bitsValue = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const color = getBit(bitsValue, i)
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      setFunctionModule(a, b, color)
      setFunctionModule(b, a, color)
    }
  }

  const alignmentPatternPositions = () => {
    if (version === 1) return []
    const numAlign = Math.floor(version / 7) + 2
    const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
    const result = [6]
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
    return result
  }

  const drawFunctionPatterns = () => {
    for (let i = 0; i < size; i++) {
      setFunctionModule(6, i, i % 2 === 0)
      setFunctionModule(i, 6, i % 2 === 0)
    }
    drawFinderPattern(3, 3)
    drawFinderPattern(size - 4, 3)
    drawFinderPattern(3, size - 4)

    const alignPos = alignmentPatternPositions()
    const numAlign = alignPos.length
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0))) {
          drawAlignmentPattern(alignPos[i], alignPos[j])
        }
      }
    }
    drawFormatBits(0) // 占位，build 里会用真实掩码重画
    drawVersion()
  }

  /** 数据码字 → (纠错 + 交错) 后的完整码字序列。 */
  const addEccAndInterleave = () => {
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ordinal][version]
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ordinal][version]
    const rawCodewords = Math.floor(numRawDataModules(version) / 8)
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
    const shortBlockLen = Math.floor(rawCodewords / numBlocks)

    const divisor = reedSolomonComputeDivisor(blockEccLen)
    const blocks = []
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = dataCodewords.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
      k += dat.length
      const ecc = reedSolomonComputeRemainder(dat, divisor)
      if (i < numShortBlocks) dat.push(0)
      blocks.push(dat.concat(ecc))
    }

    const result = []
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        // 短块多出来的那个 0 是补齐位，不参与交错
        if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i])
      })
    }
    return result
  }

  /** 从右下角起之字形把码字铺进非函数模块。 */
  const drawCodewords = (data) => {
    let i = 0
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vert : vert
          if (!isFunction[y][x] && i < data.length * 8) {
            modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7))
            i++
          }
        }
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let invert
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
        if (!isFunction[y][x] && invert) modules[y][x] = !modules[y][x]
      }
    }
  }

  /** ISO/IEC 18004 的四个罚分项（N1/N2/N3/N4），用于挑最优掩码。 */
  const penaltyScore = () => {
    let result = 0

    const finderPenaltyCountPatterns = (runHistory) => {
      const n = runHistory[1]
      const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n
      return (
        (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
        (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
      )
    }
    const finderPenaltyAddHistory = (runLen, history) => {
      let length = runLen
      if (history[0] === 0) length += size // 行首补上浅色边界
      history.pop()
      history.unshift(length)
    }
    const finderPenaltyTerminateAndCount = (runColor, runLen, history) => {
      let length = runLen
      if (runColor) {
        finderPenaltyAddHistory(length, history)
        length = 0
      }
      length += size // 行尾补上浅色边界
      finderPenaltyAddHistory(length, history)
      return finderPenaltyCountPatterns(history)
    }

    for (let y = 0; y < size; y++) {
      let runColor = false
      let runLen = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += PENALTY_N1
          else if (runLen > 5) result++
        } else {
          finderPenaltyAddHistory(runLen, history)
          if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3
          runColor = modules[y][x]
          runLen = 1
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runLen, history) * PENALTY_N3
    }

    for (let x = 0; x < size; x++) {
      let runColor = false
      let runLen = 0
      const history = [0, 0, 0, 0, 0, 0, 0]
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += PENALTY_N1
          else if (runLen > 5) result++
        } else {
          finderPenaltyAddHistory(runLen, history)
          if (!runColor) result += finderPenaltyCountPatterns(history) * PENALTY_N3
          runColor = modules[y][x]
          runLen = 1
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runLen, history) * PENALTY_N3
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y][x]
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
          result += PENALTY_N2
        }
      }
    }

    let dark = 0
    for (const row of modules) for (const cell of row) if (cell) dark++
    const total = size * size
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    result += k * PENALTY_N4

    return result
  }

  drawFunctionPatterns()
  drawCodewords(addEccAndInterleave())

  // 自动选掩码：逐个试 0-7，取罚分最低的那个（forceMask 则直接用它）。
  let best = forceMask ?? 0
  if (forceMask === undefined) {
    let minPenalty = Number.POSITIVE_INFINITY
    for (let mask = 0; mask < 8; mask++) {
      applyMask(mask)
      drawFormatBits(mask)
      const penalty = penaltyScore()
      if (penalty < minPenalty) {
        best = mask
        minPenalty = penalty
      }
      applyMask(mask) // 同样的掩码异或两次即还原
    }
  }
  applyMask(best)
  drawFormatBits(best)

  return { size, mask: best, version, modules }
}

/**
 * 把二维码矩阵转成 SVG path 数据（每个深色模块一个 1x1 方块的子路径）。
 * 渲染方自己加白底 + quiet zone 边距（推荐 4 模块）。
 */
export function qrSvgPath(code) {
  const parts = []
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y][x]) parts.push(`M${x} ${y}h1v1h-1z`)
    }
  }
  return parts.join('')
}
