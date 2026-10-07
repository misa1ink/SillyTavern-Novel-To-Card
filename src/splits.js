/**
 * 长篇小说分卷。
 *
 * 为啥要分卷：整本直接跑会让请求数、费用和失败面全部线性放大，
 * 而插件本身是「每卷独立出卡 + 独立出世界书」的模型，分卷后每卷都能单独收敛。
 *
 * 切法优先级：卷边界（章标题）> 段边界 > 硬切。
 * 也就是说，除非单个自然段比目标字数还长，否则不会在句子中间下刀。
 */

/**
 * 章标题：必须独占一行、长度受限、且匹配中文常见的章节写法。
 * 注意结尾不能用 \b —— JS 的 \b 只认 ASCII 词字符，中文「序章」后面接换行时并不构成边界。
 */
const CHAPTER_PATTERNS = [
    /^第[0-9零一二三四五六七八九十百千万两]{1,10}[章回节節篇卷部集]/,
    /^(?:序章|序言|楔子|引子|前言|后记|後記|尾声|尾聲|终章|終章|番外|附录|附錄|结语|結語|序)(?=$|\s|[:：、.．·—-])/,
    /^Chapter\s+[0-9IVXLC]+/i,
    /^(?:卷|部|篇)[0-9零一二三四五六七八九十百千万两]{1,10}/,
    /^[（(【]?[0-9]{1,4}[）)】]?\s*[、.．]?\s*$/,
];

const MAX_HEADING_LENGTH = 40;

/**
 * 找出所有章标题所在位置。
 * @param {string} text
 * @returns {{index: number, title: string}[]}
 */
export function detectChapterHeadings(text) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n');
    const headings = [];

    // 只在段首找标题，避免正文里出现「第三章」这种引用被误判
    const lineRegex = /(?:^|\n)([^\n]{1,60})/g;
    let match;
    while ((match = lineRegex.exec(source)) !== null) {
        const raw = match[1];
        const title = raw.trim();
        if (!title || title.length > MAX_HEADING_LENGTH) continue;
        if (!CHAPTER_PATTERNS.some(pattern => pattern.test(title))) continue;

        const index = match.index + (match[0].startsWith('\n') ? 1 : 0);
        headings.push({ index, title });
    }
    return headings;
}

/** 从段边界往前找最近的换行处下刀；找不到就硬切 */
function cutAtBreak(text, start, target) {
    if (start + target >= text.length) return text.length;
    const limit = start + target;
    const window = text.slice(Math.max(start, limit - 800), limit);

    const lastParagraph = window.lastIndexOf('\n');
    if (lastParagraph > 0) {
        const cut = Math.max(start, limit - 800) + lastParagraph + 1;
        if (cut > start) return cut;
    }
    const lastBreak = Math.max(
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('”'),
        window.lastIndexOf('”'),
        window.lastIndexOf('.'),
    );
    if (lastBreak > 0) {
        return Math.max(start, limit - 800) + lastBreak + 1;
    }
    return limit;
}

/** 把一段文本按目标字数切块，尽量落在段/句边界 */
function splitOversized(text, target) {
    const parts = [];
    let cursor = 0;
    while (cursor < text.length) {
        const end = cutAtBreak(text, cursor, target);
        parts.push(text.slice(cursor, end));
        cursor = end;
    }
    return parts.filter(part => part.trim());
}

/**
 * 用章标题作为分卷边界，贪心归组：
 * 依次把章塞进当前卷，塞进下一章会明显超过目标就封卷。
 * 这样每卷都尽量接近但不超过目标，也不会为一点零头多开一卷。
 *
 * @param {string} text
 * @param {number} targetChars 每卷目标字数
 * @returns {object[]|null} 章标题太少时返回 null，交给字数切分兜底
 */
function splitByChapters(text, targetChars) {
    const headings = detectChapterHeadings(text);
    // 少于 3 个标题基本可以判定这本书没有规范章节，别硬按它切
    if (headings.length < 3) return null;

    // 章区间：每个标题到下一个标题之间算一章。
    // 第一个标题之前的内容（书名页、作者的话）并入首卷，不能丢。
    const firstHeading = headings[0];
    const chapters = headings.map((heading, index) => ({
        start: heading.index,
        end: index + 1 < headings.length ? headings[index + 1].index : text.length,
        title: heading.title,
    }));
    if (firstHeading.index > 0) {
        chapters.unshift({
            start: 0,
            end: firstHeading.index,
            title: text.slice(0, firstHeading.index).trimStart().split('\n')[0].slice(0, MAX_HEADING_LENGTH) || '卷首',
        });
    }

    const volumes = [];
    let current = null;

    for (const chapter of chapters) {
        const chars = chapter.end - chapter.start;
        if (!current) {
            current = { start: chapter.start, end: chapter.end, title: chapter.title, chars };
            continue;
        }
        // 当前卷还为空时无论多大都要收下，否则会死循环
        if (current.chars + chars > targetChars * 1.15) {
            volumes.push(current);
            current = { start: chapter.start, end: chapter.end, title: chapter.title, chars };
        } else {
            current.end = chapter.end;
            current.chars += chars;
        }
    }
    if (current) volumes.push(current);

    return volumes.map(volume => ({
        start: volume.start,
        end: volume.end,
        title: volume.title,
        body: text.slice(volume.start, volume.end),
    }));
}

/**
 * 残块判定阈值：明显低于目标才算残块。
 * 注意别设成「略高于目标」——切点对齐段落边界后，正常的一卷常常略低于目标，
 * 那种卷被吞掉就会让实际卷数少于预期。
 */
function isScrap(chars, targetChars) {
    return chars < Math.max(3000, Math.floor(targetChars * 0.4));
}

/** 残块并进前卷时的体积上限，避免把前卷撑成两倍 */
function canAbsorb(previousChars, scrapChars, targetChars) {
    return previousChars + scrapChars <= targetChars * 1.8;
}

/**
 * 按字数分卷（不依赖章标题）。
 * 切点对齐段落/句子边界会让最后一块可能只剩一点点——这种残块不再另起一卷，
 * 而是直接归给前一段，避免为一个零头多花一次完整的扫描请求。
 */
function splitBySize(text, targetChars) {
    const volumes = [];
    let cursor = 0;

    while (cursor < text.length) {
        const end = cutAtBreak(text, cursor, targetChars);
        const body = text.slice(cursor, end);
        const start = cursor;
        cursor = end;

        if (!body.trim()) continue;

        const previous = volumes[volumes.length - 1];
        if (previous && isScrap(body.length, targetChars) && canAbsorb(previous.body.length, body.length, targetChars)) {
            previous.body += body;
            previous.end = end;
            continue;
        }

        volumes.push({ start, end, title: '', body });
    }
    return volumes;
}

/**
 * 按卷数精确平分：每卷的目标 = 剩余字数 / 剩余卷数，
 * 这样边界对齐带来的误差会被后面的卷吸收，最终卷数严格等于请求值。
 */
function splitIntoExactly(text, count) {
    const volumes = [];
    let cursor = 0;
    for (let remaining = count; remaining > 0; remaining--) {
        if (cursor >= text.length) break;
        if (remaining === 1) {
            volumes.push({ start: cursor, end: text.length, title: '', body: text.slice(cursor) });
            cursor = text.length;
            break;
        }
        const target = Math.ceil((text.length - cursor) / remaining);
        const end = cutAtBreak(text, cursor, target);
        volumes.push({ start: cursor, end, title: '', body: text.slice(cursor, end) });
        cursor = end;
    }
    return volumes;
}

/**
 * 把单卷内容再按目标字数切细，用于超长单卷的二次处理。
 */
export function splitVolumeBody(body, targetChars) {
    return splitOversized(String(body ?? ''), Math.max(1000, targetChars));
}

/**
 * 主入口：把整本小说分卷。
 *
 * @param {string} text
 * @param {{mode?: 'auto'|'count'|'size', volumeCount?: number, charsPerVolume?: number, byChapter?: boolean}} options
 * @returns {{volumes: object[], mode: string, chapters: number, totalChars: number, warnings: string[]}}
 */
export function splitIntoVolumes(text, options = {}) {
    const normalized = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
    const totalChars = normalized.length;
    const warnings = [];
    const mode = options.mode || 'auto';
    const byChapter = options.byChapter !== false;
    const chapters = detectChapterHeadings(normalized).length;

    if (!totalChars) {
        return { volumes: [], mode, chapters: 0, totalChars: 0, warnings: ['文本为空'] };
    }

    const explicitCount = Number(options.volumeCount) > 0 ? Math.floor(Number(options.volumeCount)) : 0;
    const explicitSize = Number(options.charsPerVolume) > 0 ? Math.floor(Number(options.charsPerVolume)) : 0;

    let effectiveSize;
    if (mode === 'count' && explicitCount > 0) {
        // 用户指定卷数：平分成 N 卷
        effectiveSize = Math.ceil(totalChars / explicitCount);
    } else if (mode === 'size' && explicitSize > 0) {
        effectiveSize = explicitSize;
    } else {
        // auto：优先用显式字数，其次按 50 万字一卷
        effectiveSize = explicitSize || 500_000;
    }

    // 只做一个"绝对"下限保护，避免用户手滑把单卷设成 100 字导致请求数爆炸。
    // 注意不能设成 10000 这种大值：那会把用户明确指定的目标（比如 3000）悄悄抬走，
    // 分卷设置就形同虚设了。
    const minSize = 1_000;
    if (effectiveSize < minSize) {
        warnings.push(`单卷字数过小（${effectiveSize}），已按 ${minSize} 字处理`);
        effectiveSize = minSize;
    }

    let volumes;

    if (mode === 'count' && explicitCount > 0 && explicitCount <= 200) {
        // 卷数是用户明确给定的，必须严格满足：用剩余字数平分，误差由后续卷吸收
        volumes = splitIntoExactly(normalized, explicitCount);
    } else {
        if (byChapter) {
            volumes = splitByChapters(normalized, effectiveSize);
            if (!volumes) {
                warnings.push(`只找到 ${chapters} 个章标题，无法按章分卷，已改用字数切分`);
            }
        }
        if (!volumes) {
            volumes = splitBySize(normalized, effectiveSize);
        }
    }

    // 章标题分卷可能出现某一章本身远超目标，二次拆开避免单卷过大
    const expanded = [];
    for (const volume of volumes) {
        if (volume.body.length > effectiveSize * 2.5) {
            const pieces = splitOversized(volume.body, effectiveSize);
            pieces.forEach((piece, index) => {
                expanded.push({
                    start: volume.start,
                    end: volume.end,
                    title: index === 0 ? volume.title : `${volume.title || '续'}（${index + 1}）`,
                    body: piece,
                });
            });
        } else {
            expanded.push(volume);
        }
    }

    const finalVolumes = expanded;

    const result = finalVolumes.map((volume, index) => ({
        index,
        label: `第 ${index + 1} 卷`,
        title: volume.title || `${volume.body.trimStart().slice(0, 20)}…`,
        chars: volume.body.length,
        start: volume.start,
        end: volume.end,
        body: volume.body,
    }));

    if (mode === 'count' && explicitCount > 0 && result.length !== explicitCount) {
        warnings.push(`请求 ${explicitCount} 卷，受章节边界影响实际分成 ${result.length} 卷`);
    }

    return { volumes: result, mode, chapters, totalChars, warnings };
}

/**
 * 单卷的成本预估，给 UI 显示用。
 */
export function estimateVolumeCost(chars, chunkChars = 6000) {
    const requests = Math.max(1, Math.ceil(chars / Math.max(1500, chunkChars)));
    return {
        scanRequests: requests,
        inputTokens: Math.round(chars / 1.5),
    };
}
