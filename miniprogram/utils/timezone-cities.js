/**
 * utils/timezone-cities.js — 时区城市字典（40+ 常用城市，含 UTC+5:30 / +5:45 / +4:30 等半小时/四十五分钟偏移）
 * 说明：所有偏移为 IANA 标准时区相对 UTC 的【标准时间】偏移（不含 DST）；
 *       DST 期间的实际偏移由 Intl.DateTimeFormat 自动计算（见 timezone.js）。
 * 数据同时作为 timezone_cities 集合种子（后端 action=timezone.list 可读）。
 */
const TIMEZONE_CITIES = [
  // —— 东亚 / 东南亚 ——
  { city: 'Beijing', city_zh: '北京', tz: 'Asia/Shanghai', utc_offset: 'UTC+8', offset_minutes: 480, dst: false },
  { city: 'Hong Kong', city_zh: '香港', tz: 'Asia/Hong_Kong', utc_offset: 'UTC+8', offset_minutes: 480, dst: false },
  { city: 'Taipei', city_zh: '台北', tz: 'Asia/Taipei', utc_offset: 'UTC+8', offset_minutes: 480, dst: false },
  { city: 'Tokyo', city_zh: '东京', tz: 'Asia/Tokyo', utc_offset: 'UTC+9', offset_minutes: 540, dst: false },
  { city: 'Seoul', city_zh: '首尔', tz: 'Asia/Seoul', utc_offset: 'UTC+9', offset_minutes: 540, dst: false },
  { city: 'Singapore', city_zh: '新加坡', tz: 'Asia/Singapore', utc_offset: 'UTC+8', offset_minutes: 480, dst: false },
  { city: 'Kuala Lumpur', city_zh: '吉隆坡', tz: 'Asia/Kuala_Lumpur', utc_offset: 'UTC+8', offset_minutes: 480, dst: false },
  { city: 'Bangkok', city_zh: '曼谷', tz: 'Asia/Bangkok', utc_offset: 'UTC+7', offset_minutes: 420, dst: false },
  { city: 'Jakarta', city_zh: '雅加达', tz: 'Asia/Jakarta', utc_offset: 'UTC+7', offset_minutes: 420, dst: false },
  { city: 'Ho Chi Minh City', city_zh: '胡志明市', tz: 'Asia/Ho_Chi_Minh', utc_offset: 'UTC+7', offset_minutes: 420, dst: false },
  // —— 南亚 / 中亚（含半小时/四十五分钟偏移） ——
  { city: 'Yangon', city_zh: '仰光', tz: 'Asia/Yangon', utc_offset: 'UTC+6:30', offset_minutes: 390, dst: false },
  { city: 'Dhaka', city_zh: '达卡', tz: 'Asia/Dhaka', utc_offset: 'UTC+6', offset_minutes: 360, dst: false },
  { city: 'New Delhi', city_zh: '新德里', tz: 'Asia/Kolkata', utc_offset: 'UTC+5:30', offset_minutes: 330, dst: false },
  { city: 'Mumbai', city_zh: '孟买', tz: 'Asia/Kolkata', utc_offset: 'UTC+5:30', offset_minutes: 330, dst: false },
  { city: 'Colombo', city_zh: '科伦坡', tz: 'Asia/Colombo', utc_offset: 'UTC+5:30', offset_minutes: 330, dst: false },
  { city: 'Kathmandu', city_zh: '加德满都', tz: 'Asia/Katmandu', utc_offset: 'UTC+5:45', offset_minutes: 345, dst: false },
  { city: 'Kabul', city_zh: '喀布尔', tz: 'Asia/Kabul', utc_offset: 'UTC+4:30', offset_minutes: 270, dst: false },
  { city: 'Tehran', city_zh: '德黑兰', tz: 'Asia/Tehran', utc_offset: 'UTC+3:30', offset_minutes: 210, dst: true },
  { city: 'Dubai', city_zh: '迪拜', tz: 'Asia/Dubai', utc_offset: 'UTC+4', offset_minutes: 240, dst: false },
  // —— 欧洲 ——
  { city: 'Moscow', city_zh: '莫斯科', tz: 'Europe/Moscow', utc_offset: 'UTC+3', offset_minutes: 180, dst: false },
  { city: 'Istanbul', city_zh: '伊斯坦布尔', tz: 'Europe/Istanbul', utc_offset: 'UTC+3', offset_minutes: 180, dst: true },
  { city: 'Kyiv', city_zh: '基辅', tz: 'Europe/Kyiv', utc_offset: 'UTC+2', offset_minutes: 120, dst: true },
  { city: 'Athens', city_zh: '雅典', tz: 'Europe/Athens', utc_offset: 'UTC+2', offset_minutes: 120, dst: true },
  { city: 'Helsinki', city_zh: '赫尔辛基', tz: 'Europe/Helsinki', utc_offset: 'UTC+2', offset_minutes: 120, dst: true },
  { city: 'Warsaw', city_zh: '华沙', tz: 'Europe/Warsaw', utc_offset: 'UTC+1', offset_minutes: 60, dst: true },
  { city: 'Stockholm', city_zh: '斯德哥尔摩', tz: 'Europe/Stockholm', utc_offset: 'UTC+1', offset_minutes: 60, dst: true },
  { city: 'Amsterdam', city_zh: '阿姆斯特丹', tz: 'Europe/Amsterdam', utc_offset: 'UTC+1', offset_minutes: 60, dst: true },
  { city: 'Berlin', city_zh: '柏林', tz: 'Europe/Berlin', utc_offset: 'UTC+1', offset_minutes: 60, dst: true },
  { city: 'Paris', city_zh: '巴黎', tz: 'Europe/Paris', utc_offset: 'UTC+1', offset_minutes: 60, dst: true },
  { city: 'Madrid', city_zh: '马德里', tz: 'Europe/Madrid', utc_offset: 'UTC+1', offset_minutes: 60, dst: true },
  { city: 'Rome', city_zh: '罗马', tz: 'Europe/Rome', utc_offset: 'UTC+1', offset_minutes: 60, dst: true },
  { city: 'London', city_zh: '伦敦', tz: 'Europe/London', utc_offset: 'UTC+0', offset_minutes: 0, dst: true },
  { city: 'Lisbon', city_zh: '里斯本', tz: 'Europe/Lisbon', utc_offset: 'UTC+0', offset_minutes: 0, dst: true },
  // —— 非洲 ——
  { city: 'Cairo', city_zh: '开罗', tz: 'Africa/Cairo', utc_offset: 'UTC+2', offset_minutes: 120, dst: true },
  { city: 'Johannesburg', city_zh: '约翰内斯堡', tz: 'Africa/Johannesburg', utc_offset: 'UTC+2', offset_minutes: 120, dst: false },
  { city: 'Lagos', city_zh: '拉各斯', tz: 'Africa/Lagos', utc_offset: 'UTC+1', offset_minutes: 60, dst: false },
  // —— 北美 ——
  { city: 'New York', city_zh: '纽约', tz: 'America/New_York', utc_offset: 'UTC-5', offset_minutes: -300, dst: true },
  { city: 'Toronto', city_zh: '多伦多', tz: 'America/Toronto', utc_offset: 'UTC-5', offset_minutes: -300, dst: true },
  { city: 'Chicago', city_zh: '芝加哥', tz: 'America/Chicago', utc_offset: 'UTC-6', offset_minutes: -360, dst: true },
  { city: 'Mexico City', city_zh: '墨西哥城', tz: 'America/Mexico_City', utc_offset: 'UTC-6', offset_minutes: -360, dst: true },
  { city: 'Denver', city_zh: '丹佛', tz: 'America/Denver', utc_offset: 'UTC-7', offset_minutes: -420, dst: true },
  { city: 'Phoenix', city_zh: '凤凰城', tz: 'America/Phoenix', utc_offset: 'UTC-7', offset_minutes: -420, dst: false },
  { city: 'Los Angeles', city_zh: '洛杉矶', tz: 'America/Los_Angeles', utc_offset: 'UTC-8', offset_minutes: -480, dst: true },
  { city: 'San Francisco', city_zh: '旧金山', tz: 'America/Los_Angeles', utc_offset: 'UTC-8', offset_minutes: -480, dst: true },
  { city: 'Vancouver', city_zh: '温哥华', tz: 'America/Vancouver', utc_offset: 'UTC-8', offset_minutes: -480, dst: true },
  { city: 'Anchorage', city_zh: '安克雷奇', tz: 'America/Anchorage', utc_offset: 'UTC-9', offset_minutes: -540, dst: true },
  { city: 'Honolulu', city_zh: '檀香山', tz: 'Pacific/Honolulu', utc_offset: 'UTC-10', offset_minutes: -600, dst: false },
  // —— 南美 ——
  { city: 'Sao Paulo', city_zh: '圣保罗', tz: 'America/Sao_Paulo', utc_offset: 'UTC-3', offset_minutes: -180, dst: true },
  { city: 'Buenos Aires', city_zh: '布宜诺斯艾利斯', tz: 'America/Argentina/Buenos_Aires', utc_offset: 'UTC-3', offset_minutes: -180, dst: false },
  { city: 'Lima', city_zh: '利马', tz: 'America/Lima', utc_offset: 'UTC-5', offset_minutes: -300, dst: false },
  { city: 'Bogota', city_zh: '波哥大', tz: 'America/Bogota', utc_offset: 'UTC-5', offset_minutes: -300, dst: false },
  // —— 大洋洲 ——
  { city: 'Sydney', city_zh: '悉尼', tz: 'Australia/Sydney', utc_offset: 'UTC+10', offset_minutes: 600, dst: true },
  { city: 'Melbourne', city_zh: '墨尔本', tz: 'Australia/Melbourne', utc_offset: 'UTC+10', offset_minutes: 600, dst: true },
  { city: 'Brisbane', city_zh: '布里斯班', tz: 'Australia/Brisbane', utc_offset: 'UTC+10', offset_minutes: 600, dst: false },
  { city: 'Perth', city_zh: '珀斯', tz: 'Australia/Perth', utc_offset: 'UTC+8', offset_minutes: 480, dst: false },
  { city: 'Auckland', city_zh: '奥克兰', tz: 'Pacific/Auckland', utc_offset: 'UTC+12', offset_minutes: 720, dst: true }
];

module.exports = { TIMEZONE_CITIES };
