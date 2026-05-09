/**
 * WebHID 设备调试工具 - 主逻辑
 * 
 * 功能：
 * - 连接 HID 设备
 * - 发送 Output Report / 获取 Feature Report
 * - 实时接收 Input Report 数据
 * - 配置项管理（打包成 2 字节：Byte0=配置类型, Byte1=配置数据）
 */

// ============ DOM 引用 ============
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectionStatus = document.getElementById('connectionStatus');
const deviceInfo = document.getElementById('deviceInfo');
const deviceInfoContent = document.getElementById('deviceInfoContent');

const reportIdInput = document.getElementById('reportId');
const hexDataInput = document.getElementById('hexData');
const reportTypeSelect = document.getElementById('reportType');
const sendBtn = document.getElementById('sendBtn');
const clearHexBtn = document.getElementById('clearHexBtn');

const clearReportsBtn = document.getElementById('clearReportsBtn');
const receiveStatus = document.getElementById('receiveStatus');
const reportsContainer = document.getElementById('reportsContainer');

// 配置区域 DOM 引用
const wirelessModeSelect = document.getElementById('wirelessMode');
const socdSelect = document.getElementById('socd');
const sleepEnableSelect = document.getElementById('sleepEnable');
const sleepTimeInput = document.getElementById('sleepTime');
const configPreviewSpan = document.getElementById('configPreview');
const sendConfigBtn = document.getElementById('sendConfigBtn');
const resetConfigBtn = document.getElementById('resetConfigBtn');
const readConfigBtn = document.getElementById('readConfigBtn');
const saveAndRebootBtn = document.getElementById('saveAndRebootBtn');

// 配置标签切换 DOM
const configTab1 = document.getElementById('configTab1');
const configTab2 = document.getElementById('configTab2');
const configPanel1 = document.getElementById('configPanel1');
const configPanel2 = document.getElementById('configPanel2');

// 按键映射 DOM
const keymapContainer = document.getElementById('keymapContainer');
const sendKeymapBtn = document.getElementById('sendKeymapBtn');
const resetKeymapBtn = document.getElementById('resetKeymapBtn');

// ============ 状态变量 ============
let device = null;           // 当前连接的 HIDDevice
let isListening = false;     // 是否正在监听 input 事件

// 存储 input 事件处理函数引用，以便移除
let inputReportHandler = null;

// 各 Report ID 的最新数据缓存 { reportId: { data: Uint8Array, count: number } }
const reportDataMap = {};

// ============ 配置管理 ============

/**
 * 配置项的默认值
 */
const DEFAULT_CONFIG = {
    wirelessMode: 1,   // 1=BLE
    socd: 0,           // 0=回中
    sleepEnable: 1,    // 1=启用
    sleepTime: 5       // 5 分钟
};

// ============ 按键映射数据 ============

/**
 * xinput 按钮列表（名称 -> 数值）
 */
const XINPUT_BUTTONS = [
    { name: 'LB', value: 0 },
    { name: 'RB', value: 1 },
    { name: 'HOME', value: 2 },
    { name: 'EMPTY', value: 3 },
    { name: 'A', value: 4 },
    { name: 'B', value: 5 },
    { name: 'X', value: 6 },
    { name: 'Y', value: 7 },
    { name: 'UP', value: 8 },
    { name: 'DOWN', value: 9 },
    { name: 'LEFT', value: 10 },
    { name: 'RIGHT', value: 11 },
    { name: 'START', value: 12 },
    { name: 'BACK', value: 13 },
    { name: 'LS', value: 14 },
    { name: 'RS', value: 15 },
    { name: 'LT', value: 16 },
    { name: 'RT', value: 17 },
    { name: 'INVALID', value: 19 }
];

/**
 * 根据 xinput 按钮值获取名称
 */
function getXinputName(value) {
    const btn = XINPUT_BUTTONS.find(b => b.value === value);
    return btn ? btn.name : `UNKNOWN(${value})`;
}

/**
 * 20 个键位的默认映射
 * 每个键位: { primary: xinput按钮值, secondary: [最多4个xinput按钮值] }
 * secondary 仅在 primary 不是 INVALID(19) 时有效
 */
const DEFAULT_KEYMAP = [
    { primary: 8,  secondary: [] },  // 0: UP
    { primary: 9,  secondary: [] },  // 1: DOWN
    { primary: 10, secondary: [] },  // 2: LEFT
    { primary: 11, secondary: [] },  // 3: RIGHT
    { primary: 4,  secondary: [] },  // 4: A
    { primary: 5,  secondary: [] },  // 5: B
    { primary: 16, secondary: [] },  // 6: LT
    { primary: 17, secondary: [] },  // 7: RT
    { primary: 6,  secondary: [] },  // 8: X
    { primary: 7,  secondary: [] },  // 9: Y
    { primary: 0,  secondary: [] },  // 10: LB
    { primary: 1,  secondary: [] },  // 11: RB
    { primary: 14, secondary: [] },  // 12: LS
    { primary: 15, secondary: [] },  // 13: RS
    { primary: 13, secondary: [] },  // 14: BACK
    { primary: 12, secondary: [] },  // 15: START
    { primary: 2,  secondary: [] },  // 16: HOME
    { primary: 8,  secondary: [] },  // 17: UP
    { primary: 19, secondary: [] },  // 18: INVALID
    { primary: 19, secondary: [] }   // 19: INVALID
];

/**
 * 将 UI 配置项打包成 6 字节数据 (配置类型 0x01)
 * Byte 0: 0x01 (固定配置类型)
 * Byte 1: 位域打包:
 *   Bit 0   - 无线模式 (1=BLE, 0=2.4G)
 *   Bits 1-2 - SOCD (0=回中, 1=后覆盖, 2=前覆盖, 3=上优先)
 *   Bit 3   - 启用睡眠 (1=启用, 0=禁用)
 *   Bits 4-7 - 无线睡眠时间 (编码: 0~15 映射到 5~20 分钟)
 * Byte 2-5: 填充 0x00
 */
function packConfig() {
    const wirelessMode = parseInt(wirelessModeSelect.value, 10);
    const socd = parseInt(socdSelect.value, 10);
    const sleepEnable = parseInt(sleepEnableSelect.value, 10);
    let sleepTime = parseInt(sleepTimeInput.value, 10);

    // 限制睡眠时间范围 5~20，编码为 0~15
    sleepTime = Math.max(5, Math.min(20, sleepTime));
    const sleepCode = sleepTime - 5; // 5→0, 6→1, ..., 20→15

    let configByte = 0;
    configByte |= (wirelessMode & 0x01) << 0;       // Bit 0
    configByte |= (socd & 0x03) << 1;               // Bits 2-1
    configByte |= (sleepEnable & 0x01) << 3;        // Bit 3
    configByte |= (sleepCode & 0x0F) << 4;          // Bits 7-4

    return new Uint8Array([0x01, configByte, 0x00, 0x00, 0x00, 0x00]);
}

/**
 * 解析 2 字节配置数据并更新 UI
 */
function unpackConfig(data) {
    if (data.length < 2) {
        appendLog('⚠️ 配置数据不足 2 字节，无法解析', 'error');
        return;
    }

    const configType = data[0];
    const configByte = data[1];

    const wirelessMode = (configByte >> 0) & 0x01;
    const socd = (configByte >> 1) & 0x03;
    const sleepEnable = (configByte >> 3) & 0x01;
    const sleepCode = (configByte >> 4) & 0x0F;
    const sleepTime = sleepCode + 5;

    // 更新 UI（仅更新无线/睡眠字段，不修改配置类型）
    wirelessModeSelect.value = String(wirelessMode);
    socdSelect.value = String(socd);
    sleepEnableSelect.value = String(sleepEnable);
    sleepTimeInput.value = sleepTime;

    updateConfigPreview();

    appendLog(
        `⚙️ 配置已解析: 类型=0x${configType.toString(16).padStart(2, '0')}` +
        ` | 无线模式=${wirelessMode === 1 ? 'BLE' : '2.4G'}` +
        ` | SOCD=${['回中', '后覆盖', '前覆盖', '上优先'][socd]}` +
        ` | 睡眠=${sleepEnable === 1 ? '启用' : '禁用'}` +
        ` | 睡眠时间=${sleepTime}分钟`,
        'info'
    );
}

/**
 * 更新配置字节预览
 */
function updateConfigPreview() {
    const packed = packConfig();
    const hexStr = Array.from(packed)
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
    configPreviewSpan.textContent = hexStr;
}

/**
 * 重置配置为默认值
 */
function resetConfig() {
    wirelessModeSelect.value = String(DEFAULT_CONFIG.wirelessMode);
    socdSelect.value = String(DEFAULT_CONFIG.socd);
    sleepEnableSelect.value = String(DEFAULT_CONFIG.sleepEnable);
    sleepTimeInput.value = String(DEFAULT_CONFIG.sleepTime);
    updateConfigPreview();
    appendLog('↺ 配置已重置为默认值', 'info');
}

/**
 * 发送配置到设备 (Report ID = 0, Output Report)
 */
async function sendConfig() {
    if (!device) {
        appendLog('⚠️ 请先连接设备', 'error');
        return;
    }

    const packedData = packConfig();
    const reportId = 0; // 配置使用 Report ID 0

    try {
        await device.sendReport(reportId, packedData);
        appendLog(
            `📤 配置已发送 [ID=${reportId}] | 6B: ${Array.from(packedData).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`,
            'sent',
            packedData
        );
    } catch (err) {
        console.error('发送配置失败:', err);
        appendLog(`❌ 发送配置失败: ${err.message}`, 'error');
    }
}

/**
 * 读取配置 (通过 Feature Report)
 */
async function readConfig() {
    if (!device) {
        appendLog('⚠️ 请先连接设备', 'error');
        return;
    }

    const reportId = 0;

    try {
        // 根据当前激活的面板决定读取的配置类型
        const isPanel1Active = !configPanel1.classList.contains('hidden');
        const configType = isPanel1Active ? 0x01 : 0x02;

        // 先发送一个读取请求（Output Report，配置类型 + 填充）
        const requestData = new Uint8Array([configType, 0x00, 0x00, 0x00, 0x00, 0x00]);
        await device.sendReport(reportId, requestData);
        appendLog(`📤 配置读取请求已发送 [类型=0x${configType.toString(16).padStart(2, '0')}]`, 'info', requestData);

        // 然后通过 Feature Report 读取
        const reportData = await device.receiveFeatureReport(reportId);
        const data = new Uint8Array(reportData.buffer);

        appendLog(
            `📩 配置读取响应 [ID=${reportId}] | ${data.length}B: ${Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}`,
            'received',
            data
        );

        // 如果至少 2 字节且是类型 0x01，尝试解析配置
        if (data.length >= 2 && data[0] === 0x01) {
            unpackConfig(data);
        }

    } catch (err) {
        console.error('读取配置失败:', err);
        appendLog(`❌ 读取配置失败: ${err.message}`, 'error');
    }
}

/**
 * 保存配置并重启 (发送 Report ID=0, 6字节: [0xFF][0][0][0][0][0])
 */
async function saveAndReboot() {
    if (!device) {
        appendLog('⚠️ 请先连接设备', 'error');
        return;
    }

    const data = new Uint8Array([0xFF, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const reportId = 0;

    try {
        await device.sendReport(reportId, data);
        appendLog(
            `💾 保存配置并重启命令已发送 [ID=${reportId}] | 6B: ${bytesToHex(data)}`,
            'sent',
            data
        );
    } catch (err) {
        console.error('保存配置并重启失败:', err);
        appendLog(`❌ 保存配置并重启失败: ${err.message}`, 'error');
    }
}

// ============ 按键映射管理 ============

/**
 * 当前按键映射数组（20个键位）
 * 每个元素: { primary: number (xinput按钮值), secondary: number[] (最多4个) }
 */
let currentKeymap = JSON.parse(JSON.stringify(DEFAULT_KEYMAP));

/**
 * 生成 xinput 按钮下拉选项 HTML（排除 INVALID）
 */
function generateXinputOptions(selectedValue, includeInvalid = false) {
    let buttons = XINPUT_BUTTONS;
    if (!includeInvalid) {
        buttons = buttons.filter(b => b.value !== 19); // 排除 INVALID
    }
    return buttons.map(btn => {
        const selected = btn.value === selectedValue ? ' selected' : '';
        return `<option value="${btn.value}"${selected}>${btn.name} (${btn.value})</option>`;
    }).join('');
}

/**
 * 渲染单个键位的 secondary 选择器（右侧最多4个）
 */
function renderSecondarySelectors(keyIndex, container, entry) {
    // 清除旧的 secondary 区域
    const oldSecondary = container.querySelector('.keymap-secondary');
    if (oldSecondary) oldSecondary.remove();

    // 如果 primary 是 INVALID，不显示 secondary
    if (entry.primary === 19) return;

    const secondaryDiv = document.createElement('div');
    secondaryDiv.className = 'keymap-secondary';

    // 确保至少有一个 secondary 选择项（默认 INVALID）
    if (entry.secondary.length === 0) {
        entry.secondary.push(19);
    }

    // 确保不超过 4 个
    while (entry.secondary.length > 4) {
        entry.secondary.pop();
    }

    for (let s = 0; s < entry.secondary.length; s++) {
        const sel = document.createElement('select');
        sel.className = 'input-field keymap-secondary-select';
        sel.innerHTML = generateXinputOptions(entry.secondary[s], true);

        sel.addEventListener('change', () => {
            entry.secondary[s] = parseInt(sel.value, 10);
            // 如果这个选项变成非 INVALID 且后面没有空位了，添加一个新的 INVALID 选项
            if (entry.secondary[s] !== 19 && entry.secondary.length < 4) {
                const lastVal = entry.secondary[entry.secondary.length - 1];
                if (lastVal !== 19) {
                    entry.secondary.push(19);
                    renderSecondarySelectors(keyIndex, container, entry);
                }
            }
            // 如果这个变成 INVALID 且后面还有有效的，截掉后面的
            if (entry.secondary[s] === 19 && s < entry.secondary.length - 1) {
                entry.secondary = entry.secondary.slice(0, s + 1);
                renderSecondarySelectors(keyIndex, container, entry);
            }
        });

        secondaryDiv.appendChild(sel);
    }

    container.appendChild(secondaryDiv);
}

/**
 * 渲染按键映射 UI（所有下拉框在同一行）
 */
function renderKeymap() {
    keymapContainer.innerHTML = '';

    for (let i = 0; i < 20; i++) {
        const entry = currentKeymap[i];
        const item = document.createElement('div');
        item.className = 'keymap-item';
        item.dataset.keyIndex = i;

        // 发送按钮（放在最左边）
        const sendBtn = document.createElement('button');
        sendBtn.className = 'keymap-send-btn';
        sendBtn.title = `发送键位 ${i} 的映射 Report`;
        sendBtn.textContent = '▶';
        sendBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!device) {
                appendLog('⚠️ 请先连接设备', 'error');
                return;
            }
            try {
                await sendSingleKeymap(device, i, entry);
                appendLog(`📤 键位 ${i} Report 已发送`, 'sent');
            } catch (err) {
                appendLog(`❌ 键位 ${i} 发送失败: ${err.message}`, 'error');
            }
        });

        const indexSpan = document.createElement('span');
        indexSpan.className = 'keymap-index';
        indexSpan.textContent = String(i).padStart(2, '0');

        const labelSpan = document.createElement('span');
        labelSpan.className = 'keymap-label';
        labelSpan.textContent = `键位 ${i}`;

        const primarySelect = document.createElement('select');
        primarySelect.className = 'input-field keymap-primary-select';
        primarySelect.innerHTML = generateXinputOptions(entry.primary, true);

        primarySelect.addEventListener('change', () => {
            const newVal = parseInt(primarySelect.value, 10);
            entry.primary = newVal;
            if (newVal === 19) {
                // primary 变 INVALID，清空 secondary
                entry.secondary = [];
            } else {
                // primary 从 INVALID 变有效，添加一个默认 INVALID 的 secondary
                if (entry.secondary.length === 0) {
                    entry.secondary.push(19);
                }
            }
            // 重绘 secondary 部分
            renderSecondarySelectors(i, item, entry);
        });

        item.appendChild(sendBtn);
        item.appendChild(indexSpan);
        item.appendChild(labelSpan);
        item.appendChild(primarySelect);

        // secondary 选择器
        renderSecondarySelectors(i, item, entry);

        keymapContainer.appendChild(item);
    }
}

/**
 * 根据 3 字节状态数据更新按键映射高亮
 * 3 字节共 24 位，前 20 位对应键位 0~19
 */
function updateKeymapHighlights(stateData) {
    if (!stateData || stateData.length < 3) return;

    // 拼装 24 位整数（小端序：byte0 = bits 0-7, byte1 = bits 8-15, byte2 = bits 16-23）
    const bits = (stateData[2] << 16) | (stateData[1] << 8) | stateData[0];

    for (let i = 0; i < 20; i++) {
        const item = keymapContainer.querySelector(`.keymap-item[data-key-index="${i}"]`);
        if (!item) continue;

        const isActive = (bits >> i) & 0x01;
        item.classList.toggle('keymap-active', isActive);
    }
}

/**
 * 重置按键映射为默认值
 */
function resetKeymap() {
    currentKeymap = JSON.parse(JSON.stringify(DEFAULT_KEYMAP));
    renderKeymap();
    appendLog('↺ 按键映射已重置为默认值', 'info');
}

/**
 * 发送单个键位的映射 Report
 * 6 字节: [0x02] [键位索引] [映射值1] [映射值2] [映射值3] [映射值4]
 */
async function sendSingleKeymap(device, keyIndex, entry) {
    const data = new Uint8Array(6);
    data[0] = 0x02;
    data[1] = keyIndex & 0xFF;
    // 第1个字节是 primary
    data[2] = entry.primary & 0xFF;
    // 第2~4个字节是 secondary（最多3个，因为总共6字节，第1字节类型，第2字节键位索引，第3字节primary，剩下3个给secondary）
    // 但实际上文档说第3~6字节是按键值，共4个字节
    // primary 占第3字节，secondary 最多3个占第4~6字节
    for (let s = 0; s < 3; s++) {
        if (s < entry.secondary.length) {
            data[3 + s] = entry.secondary[s] & 0xFF;
        } else {
            data[3 + s] = 0x13; // INVALID = 19
        }
    }

    await device.sendReport(0, data);
}

/**
 * 发送全部按键映射（每 10ms 发送一个，共 20 个 Report）
 */
async function sendAllKeymaps() {
    if (!device) {
        appendLog('⚠️ 请先连接设备', 'error');
        return;
    }

    appendLog('⏳ 开始发送按键映射 (20个 Report, 每10ms一个)...', 'info');

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < 20; i++) {
        const entry = currentKeymap[i];
        try {
            await sendSingleKeymap(device, i, entry);
            successCount++;

            // 构建日志信息
            let keyStr = `键位 ${i} → ${getXinputName(entry.primary)}`;
            if (entry.secondary.length > 0 && entry.secondary[0] !== 19) {
                const secStr = entry.secondary
                    .filter(v => v !== 19)
                    .map(v => getXinputName(v))
                    .join(', ');
                if (secStr) keyStr += ` + ${secStr}`;
            }

            // 每 5 个输出一次进度
            if ((i + 1) % 5 === 0 || i === 19) {
                appendLog(`📤 按键映射进度: ${i + 1}/20 (${keyStr})`, 'sent');
            }
            // 等 10ms 再发下一个
            if (i < 19) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        } catch (err) {
            failCount++;
            appendLog(`❌ 键位 ${i} 发送失败: ${err.message}`, 'error');
        }
    }

    appendLog(
        `✅ 按键映射发送完成: 成功 ${successCount} 个, 失败 ${failCount} 个`,
        successCount > 0 ? 'info' : 'error'
    );
}

// ============ 配置标签切换 ============

/**
 * 切换到指定配置面板
 */
function switchConfigTab(tabIndex) {
    if (tabIndex === 1) {
        configTab1.classList.add('config-tab-active');
        configTab2.classList.remove('config-tab-active');
        configPanel1.classList.remove('hidden');
        configPanel2.classList.add('hidden');
    } else {
        configTab2.classList.add('config-tab-active');
        configTab1.classList.remove('config-tab-active');
        configPanel2.classList.remove('hidden');
        configPanel1.classList.add('hidden');
    }
    updateConfigPreview();
}

// ============ 工具函数 ============

/**
 * 将字节数组 (Uint8Array / Array) 转为 16 进制字符串
 */
function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
}

/**
 * 将 16 进制字符串转为字节数组
 */
function hexToBytes(hexStr) {
    // 移除空格、0x 前缀等无关字符
    const clean = hexStr.replace(/\s+/g, '').replace(/0x/gi, '');
    if (clean.length === 0) return new Uint8Array(0);
    if (clean.length % 2 !== 0) {
        throw new Error('16进制字符串长度必须为偶数（每个字节两位十六进制）');
    }
    const bytes = [];
    for (let i = 0; i < clean.length; i += 2) {
        bytes.push(parseInt(clean.substring(i, i + 2), 16));
    }
    return new Uint8Array(bytes);
}

/**
 * 获取当前时间戳字符串
 */
function getTimestamp() {
    const now = new Date();
    return now.toLocaleTimeString('zh-CN', { hour12: false }) +
        '.' + String(now.getMilliseconds()).padStart(3, '0');
}

/**
 * 向隐藏日志输出添加一条记录
 */
function appendLog(message, type = 'default', rawBytes = null) {
    const hiddenLog = document.getElementById('hiddenLog');
    if (!hiddenLog) return;
    const timestamp = getTimestamp();
    const timeStr = `<span class="log-timestamp">[${timestamp}]</span>`;
    const msgStr = `<span class="log-${type}">${message}</span>`;

    // 如果有原始字节数据，附加显示
    let hexStr = '';
    if (rawBytes) {
        hexStr = ` <span class="log-timestamp">(${bytesToHex(rawBytes)})</span>`;
    }

    hiddenLog.innerHTML += `${timeStr} ${msgStr}${hexStr}\n`;
    // 保留最近 500 条
    const lines = hiddenLog.innerHTML.split('\n');
    if (lines.length > 500) {
        hiddenLog.innerHTML = lines.slice(-500).join('\n');
    }
}

/**
 * 清空日志（保留函数签名，但不再需要）
 */
function clearLog() {
    const hiddenLog = document.getElementById('hiddenLog');
    if (hiddenLog) hiddenLog.innerHTML = '';
}

/**
 * 更新连接状态 UI
 */
function updateConnectionUI() {
    const connected = device !== null;

    connectBtn.disabled = connected;
    disconnectBtn.disabled = !connected;
    sendBtn.disabled = !connected;
    sendConfigBtn.disabled = !connected;
    readConfigBtn.disabled = !connected;
    saveAndRebootBtn.disabled = !connected;
    sendKeymapBtn.disabled = !connected;

    if (connected) {
        connectionStatus.textContent = '已连接';
        connectionStatus.className = 'status-badge status-connected';
    } else {
        connectionStatus.textContent = '未连接';
        connectionStatus.className = 'status-badge status-disconnected';
    }
}

/**
 * 显示设备信息
 */
function showDeviceInfo(dev) {
    deviceInfo.classList.remove('hidden');

    const collections = dev.collections.map((col, i) => {
        return `  [集合 ${i}]
    Usage Page:  0x${col.usagePage.toString(16)}
    Usage:       0x${col.usage.toString(16)}
    Type:        ${col.type}
`.trim();
    }).join('\n');

    const infoText = `制造商:  ${dev.manufacturerName || '未知'}
产品名:  ${dev.productName || '未知'}
产品 ID: 0x${dev.productId.toString(16).padStart(4, '0')}
厂商 ID: 0x${dev.vendorId.toString(16).padStart(4, '0')}

集合:
${collections || '  (无集合信息)'}`;

    deviceInfoContent.textContent = infoText;

    // 在日志中显示连接信息
    appendLog(`✅ 已连接设备: ${dev.productName || '未知'} (VID: 0x${dev.vendorId.toString(16).padStart(4, '0')}, PID: 0x${dev.productId.toString(16).padStart(4, '0')})`, 'info');
}

/**
 * 隐藏设备信息
 */
function hideDeviceInfo() {
    deviceInfo.classList.add('hidden');
    deviceInfoContent.textContent = '';
}

// ============ 核心功能 ============

/**
 * 连接 HID 设备
 */
async function connectDevice() {
    try {
        // 请求选择设备
        const devices = await navigator.hid.requestDevice({
            filters: []   // 不限制，显示所有可用 HID 设备
        });

        if (devices.length === 0) {
            appendLog('⚠️ 未选择任何设备', 'error');
            return;
        }

        const selectedDevice = devices[0];

        // 打开设备
        await selectedDevice.open();
        device = selectedDevice;
        updateConnectionUI();
        showDeviceInfo(device);

        appendLog('🔓 设备已打开，等待用户操作...', 'info');

        // 自动开始监听
        startListening();

    } catch (err) {
        console.error('连接失败:', err);
        appendLog(`❌ 连接失败: ${err.message}`, 'error');
    }
}

/**
 * 断开 HID 设备
 */
async function disconnectDevice() {
    if (!device) return;

    try {
        // 先停止监听
        if (isListening) {
            stopListening();
        }

        // 断开后清空报告
        clearAllReports();

        await device.close();
        appendLog(`🔌 设备已断开: ${device.productName || '未知'}`, 'info');

    } catch (err) {
        console.error('断开失败:', err);
        appendLog(`❌ 断开失败: ${err.message}`, 'error');
    } finally {
        device = null;
        hideDeviceInfo();
        updateConnectionUI();
    }
}

/**
 * 获取或创建某个 Report ID 的显示卡片
 */
function getOrCreateReportCard(reportId) {
    let card = document.getElementById(`report-card-${reportId}`);
    if (card) return card;

    // 移除 placeholder
    const placeholder = reportsContainer.querySelector('.reports-placeholder');
    if (placeholder) placeholder.remove();

    card = document.createElement('div');
    card.className = 'report-card';
    card.id = `report-card-${reportId}`;

    card.innerHTML = `
        <div class="report-card-header">
            <span class="report-card-title">Report ID = ${reportId}</span>
            <span class="report-card-stats" id="report-stats-${reportId}">计数: 0</span>
        </div>
        <div class="report-card-body" id="report-body-${reportId}">—</div>
    `;

    reportsContainer.appendChild(card);
    return card;
}

/**
 * 更新指定 Report ID 的显示数据
 */
function updateReportDisplay(reportId) {
    const entry = reportDataMap[reportId];
    if (!entry) return;

    const bodyEl = document.getElementById(`report-body-${reportId}`);
    const statsEl = document.getElementById(`report-stats-${reportId}`);

    if (bodyEl) {
        bodyEl.textContent = bytesToHex(entry.data);
        // 闪动效果
        bodyEl.classList.remove('flash');
        void bodyEl.offsetWidth; // 触发 reflow
        bodyEl.classList.add('flash');
    }
    if (statsEl) {
        statsEl.textContent = `计数: ${entry.count} | ${entry.data.length}B`;
    }
}

/**
 * 开始监听设备的 InputReport
 */
function startListening() {
    if (!device || isListening) return;

    isListening = true;
    updateConnectionUI();
    receiveStatus.textContent = '监听中';
    receiveStatus.className = 'status-badge status-connected';

    // 定义 input 事件处理函数
    inputReportHandler = (event) => {
        const data = new Uint8Array(event.data.buffer);
        const reportId = event.reportId;

        // 更新缓存
        if (!reportDataMap[reportId]) {
            reportDataMap[reportId] = { data: null, count: 0 };
            // 首次出现，创建卡片
            getOrCreateReportCard(reportId);
        }
        const entry = reportDataMap[reportId];
        entry.data = data;
        entry.count++;

        // 更新显示
        updateReportDisplay(reportId);

        // 如果是 3 字节的 report，解析前 20 位更新按键映射高亮
        if (data.length === 3) {
            updateKeymapHighlights(data);
        }
    };

    device.addEventListener('inputreport', inputReportHandler);
}

/**
 * 停止监听设备的 InputReport
 */
function stopListening() {
    if (!device || !isListening) return;

    isListening = false;
    updateConnectionUI();
    receiveStatus.textContent = '已停止';
    receiveStatus.className = 'status-badge status-disconnected';

    if (inputReportHandler && device) {
        device.removeEventListener('inputreport', inputReportHandler);
        inputReportHandler = null;
    }
}

/**
 * 清空所有报告数据
 */
function clearAllReports() {
    // 清空缓存
    for (const key of Object.keys(reportDataMap)) {
        delete reportDataMap[key];
    }
    // 清空 DOM
    reportsContainer.innerHTML = `<div class="reports-placeholder">等待设备连接并接收数据...</div>`;
    // 清除按键高亮
    clearKeymapHighlights();
}

/**
 * 清除所有按键高亮
 */
function clearKeymapHighlights() {
    const items = keymapContainer.querySelectorAll('.keymap-item');
    items.forEach(item => item.classList.remove('keymap-active'));
}

/**
 * 发送数据到设备
 */
async function sendData() {
    if (!device) {
        appendLog('⚠️ 请先连接设备', 'error');
        return;
    }

    const reportIdStr = reportIdInput.value.trim();
    const hexStr = hexDataInput.value.trim();

    if (!hexStr) {
        appendLog('⚠️ 请输入要发送的16进制数据', 'error');
        return;
    }

    let reportId = 0;
    try {
        reportId = parseInt(reportIdStr, 10);
        if (isNaN(reportId) || reportId < 0 || reportId > 255) {
            throw new Error('Report ID 必须在 0-255 之间');
        }
    } catch (err) {
        appendLog(`⚠️ ${err.message}`, 'error');
        return;
    }

    let data;
    try {
        data = hexToBytes(hexStr);
    } catch (err) {
        appendLog(`⚠️ 数据解析错误: ${err.message}`, 'error');
        return;
    }

    if (data.length === 0) {
        appendLog('⚠️ 数据为空，请检查输入', 'error');
        return;
    }

    const reportType = reportTypeSelect.value; // 'output' 或 'feature'

    try {
        if (reportType === 'output') {
            // 发送 Output Report
            await device.sendReport(reportId, data);
            appendLog(
                `📤 Output Report [ID=${reportId}] | ${data.length}B: ${bytesToHex(data)}`,
                'sent',
                data
            );
        } else {
            // 发送 Feature Report
            await device.sendFeatureReport(reportId, data);
            appendLog(
                `📤 Feature Report [ID=${reportId}] | ${data.length}B: ${bytesToHex(data)}`,
                'sent',
                data
            );
        }
    } catch (err) {
        console.error('发送失败:', err);
        appendLog(`❌ 发送失败: ${err.message}`, 'error');
    }
}

/**
 * 接收 Feature Report（获取）
 */
async function receiveFeatureReport() {
    if (!device) {
        appendLog('⚠️ 请先连接设备', 'error');
        return;
    }

    const reportIdStr = reportIdInput.value.trim();
    let reportId = 0;
    try {
        reportId = parseInt(reportIdStr, 10);
        if (isNaN(reportId) || reportId < 0 || reportId > 255) {
            throw new Error('Report ID 必须在 0-255 之间');
        }
    } catch (err) {
        appendLog(`⚠️ ${err.message}`, 'error');
        return;
    }

    try {
        const reportData = await device.receiveFeatureReport(reportId);
        const data = new Uint8Array(reportData.buffer);

        appendLog(
            `📩 Feature Report [ID=${reportId}] | ${data.length}B: ${bytesToHex(data)}`,
            'received',
            data
        );

    } catch (err) {
        console.error('获取 Feature Report 失败:', err);
        appendLog(`❌ 获取 Feature Report 失败: ${err.message}`, 'error');
    }
}

// ============ 事件绑定 ============

// 连接 / 断开
connectBtn.addEventListener('click', connectDevice);
disconnectBtn.addEventListener('click', disconnectDevice);

// 发送
sendBtn.addEventListener('click', sendData);

// 清空输入
clearHexBtn.addEventListener('click', () => {
    hexDataInput.value = '';
    hexDataInput.focus();
});

// 清空报告
clearReportsBtn.addEventListener('click', clearAllReports);

// 键盘快捷发送（Ctrl+Enter / Shift+Enter）
hexDataInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendData();
    }
});

// ============ 配置事件绑定 ============

// 配置项变更时更新预览
wirelessModeSelect.addEventListener('change', updateConfigPreview);
socdSelect.addEventListener('change', updateConfigPreview);
sleepEnableSelect.addEventListener('change', updateConfigPreview);
sleepTimeInput.addEventListener('input', () => {
    // 限制范围 5~20
    let val = parseInt(sleepTimeInput.value, 10);
    if (isNaN(val)) val = 5;
    val = Math.max(5, Math.min(20, val));
    sleepTimeInput.value = val;
    updateConfigPreview();
});

// 发送配置按钮
sendConfigBtn.addEventListener('click', sendConfig);

// 重置配置按钮
resetConfigBtn.addEventListener('click', resetConfig);

// 读取配置按钮
readConfigBtn.addEventListener('click', readConfig);

// 保存配置并重启按钮
saveAndRebootBtn.addEventListener('click', saveAndReboot);

// ============ 按键映射事件绑定 ============

// 配置标签切换
configTab1.addEventListener('click', () => switchConfigTab(1));
configTab2.addEventListener('click', () => switchConfigTab(2));

// 发送全部按键映射
sendKeymapBtn.addEventListener('click', sendAllKeymaps);

// 重置按键映射
resetKeymapBtn.addEventListener('click', resetKeymap);

// ============ 初始化 ============

// 初始化 UI
updateConnectionUI();

// 初始化配置预览
updateConfigPreview();

// 初始化按键映射 UI
renderKeymap();

// 浏览器兼容性检查
if (!navigator.hid) {
    appendLog('❌ 您的浏览器不支持 WebHID API。请使用 Chrome 89+ 或 Edge 89+，并启用 HTTPS 或 localhost。', 'error');
    document.body.innerHTML = `
        <div style="text-align:center;margin-top:100px;color:#f87171;font-size:1.2rem;">
            <h2>❌ 浏览器不支持 WebHID</h2>
            <p style="margin-top:16px;color:#94a3b8;">
                请使用 Chrome 89+ 或 Edge 89+，并通过 HTTPS 或 localhost 访问。
            </p>
        </div>
    `;
}

// 如果在非 HTTPS / 非 localhost 环境下提醒
if (navigator.hid && location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    appendLog('⚠️ 当前非安全环境 (${location.protocol}//${location.host})。WebHID 需要 HTTPS 才能运行。', 'error');
}

console.log('WebHID 调试工具已启动！');
