import React, {useEffect, useId, useRef} from 'react';
import styles from './dialog.module.css';

interface DialogProps {
  title: React.ReactNode;
  /** Esc、关闭按钮、表单提交后都会走到这里；由调用方决定是否卸载本组件 */
  onClose: () => void;
  /** 固定在底部、不参与内容滚动的操作区 */
  footer?: React.ReactNode;
  /** 通常只用来给具体对话框定宽 */
  className?: string;
  children: React.ReactNode;
}

/**
 * 模态对话框，基于原生 <dialog> + showModal()。
 *
 * 选它而不是自绘一层遮罩，是因为浏览器一口气给了三样东西：Top Layer（天然盖住一切，
 * 全项目的 z-index 得以一直是 0）、内建的焦点陷阱、以及 Esc 关闭。
 * 代价是几个 UA 默认值会被本项目的全局 reset 打掉，见 dialog.module.css 里的说明。
 *
 * 挂载即打开：调用方用 {open && <Dialog …/>} 控制，不做受控 open ——
 * 与 CaDialog 原来的用法一致，也免去「DOM 已关、状态还说开着」的不同步。
 */
export const Dialog = (props: DialogProps): React.ReactElement => {
  const {title, onClose, footer, className, children} = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = `${useId()}-title`;

  useEffect(() => {
    const dialog = dialogRef.current;
    // 这个守卫是必需的：StrictMode 下挂载期的 effect 会跑两次，
    // 对已经 open 的 dialog 再调一次 showModal() 会抛 InvalidStateError
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={[styles.dialog, className ?? ''].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      onClose={onClose}
    >
      <h2 id={titleId} className={styles.title}>
        {title}
      </h2>
      <div className={styles.body}>{children}</div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </dialog>
  );
};
