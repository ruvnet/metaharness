/**
 * Drag-drop + click-to-pick image input. Wires an element so dropping or
 * picking an image file invokes `onFile`.
 */

export function makeDropZone(el: HTMLElement, onFile: (file: File) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  el.appendChild(input);

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) onFile(file);
    input.value = '';
  });

  el.addEventListener('click', (e) => {
    // Don't hijack clicks on interactive children (e.g. webcam buttons).
    if ((e.target as HTMLElement).closest('button, input, a, video')) return;
    input.click();
  });

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) onFile(file);
  });
}
