/**
 * 设置的共享约束。
 *
 * 端口校验必须两边同一份：渲染进程拿它判断输入框什么时候算填完，
 * 主进程拿它拒绝落盘。各写一份迟早会漂，漂了就是「界面允许、保存被悄悄改回去」。
 */

/** 1024 以下是特权端口，绑定需要 root，不给填 */
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

export const isValidPort = (port: unknown): port is number =>
  typeof port === 'number' && Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
