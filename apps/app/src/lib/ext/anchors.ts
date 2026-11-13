/**
 * Anchors an ST extension expects to find at any moment, kept alive across page changes
 * (DEV_NOTES §9.34, rounds 3 and 10). ST's page never unmounts `#send_form`, and extensions hold on
 * to it (observers, cached jQuery sets); our chat page does unmount. So the form box and the
 * quick-reply bar in it are one pair of elements for the whole session: the composer hosts them
 * while it is mounted, a hidden parking spot the rest of the time.
 */
let form: HTMLElement | undefined;
let bar: HTMLElement | undefined;
let parking: HTMLElement | undefined;

function parkingSpot(): HTMLElement {
  if (!parking) {
    parking = document.createElement('div');
    parking.className = 'tm-ext-parking';
    parking.hidden = true;
    document.body.append(parking);
  }
  return parking;
}

/** ST's `#send_form` (a div there too). Created on first use, parked until a composer hosts it. */
export function sendForm(): HTMLElement {
  if (!form) {
    form = document.createElement('div');
    form.id = 'send_form';
    form.className = 'tm-composer';
    parkingSpot().append(form);
  }
  return form;
}

/** ST's `#qr--bar`, always the first child of `#send_form`. What extensions put in it stays there. */
export function qrBar(): HTMLElement {
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'qr--bar';
    bar.className = 'flex-container flexGap5';
    sendForm().prepend(bar);
  }
  return bar;
}

/**
 * Svelte action for the composer's `<form>`: what the component rendered in it (block anchors
 * included, so later `{#if}` inserts land in the right place) moves into `#send_form`, which then
 * sits in the form. On unmount the component gets its nodes back and `#send_form` is parked.
 */
export function hostSendForm(host: HTMLElement): { destroy(): void } {
  const box = sendForm();
  const keep = qrBar();
  box.append(...host.childNodes);
  host.append(box);
  return {
    destroy() {
      for (const node of [...box.childNodes]) {
        if (node !== keep) host.append(node);
      }
      parkingSpot().append(box);
    },
  };
}
