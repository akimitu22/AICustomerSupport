export async function unlock(ctx) {
  if (ctx.state === 'running') return;
  const resume = () =>
    ctx.resume().finally(() => {
      window.removeEventListener('touchend', resume, { passive: true });
      window.removeEventListener('click', resume, { passive: true });
    });
  window.addEventListener('touchend', resume, { passive: true });
  window.addEventListener('click', resume, { passive: true });
}
