import { readImage, uploadImage } from "./credit-ui.mjs";
export async function mountPicture(container, { api, esc, loading, isCurrent, name, sandbox = false, config = {}, onSaved = () => {} }) {
  const picture = await api("/api/profile/picture");
  if (!isCurrent()) return;
  container.innerHTML = `<h2>Profile picture</h2><div class="profile-picture-preview">${picture.image ? `<img src="${esc(picture.image)}" alt="Your profile picture">` : `<span aria-label="No profile picture">${esc(name.split(/\s+/).map(part => part[0]).slice(0,2).join(""))}</span>`}</div><form class="picture-form"><div class="field"><label for="profile-picture">Choose a picture</label><input id="profile-picture" type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" required><small>PNG or JPEG, up to ${sandbox ? 1 : 5} MB.</small></div><div class="picture-crop" hidden><p>Drag the picture to position it, or use the sliders.</p><canvas width="280" height="280" aria-label="Profile picture crop preview"></canvas><div class="field"><label for="crop-zoom">Zoom</label><input id="crop-zoom" type="range" min="1" max="3" step="0.01" value="1"></div><div class="field"><label for="crop-x">Horizontal position</label><input id="crop-x" type="range" min="-1" max="1" step="0.01" value="0"></div><div class="field"><label for="crop-y">Vertical position</label><input id="crop-y" type="range" min="-1" max="1" step="0.01" value="0"></div><button type="button" class="button ghost" data-reset-crop>Reset crop</button></div><div class="picture-feedback" role="status"></div><div class="picture-actions"><button class="button gold" type="submit">Save picture</button>${picture.image ? '<button class="button ghost" type="button" data-remove-picture>Remove</button>' : ""}</div></form>`;
  const form = container.querySelector("form"), feedback = form.querySelector(".picture-feedback");
  const chooser = form.querySelector('#profile-picture'), crop = form.querySelector('.picture-crop'), canvas = crop.querySelector('canvas');
  const zoom = crop.querySelector('#crop-zoom'), x = crop.querySelector('#crop-x'), y = crop.querySelector('#crop-y');
  let image = null, loadVersion = 0, dragging = null;
  const geometry = () => {
    const scale = Math.max(canvas.width / image.width, canvas.height / image.height) * Number(zoom.value);
    return { width: image.width * scale, height: image.height * scale };
  };
  function draw() {
    if (!image) return;
    const {width, height} = geometry(), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(image, (canvas.width-width)/2 + Number(x.value)*(width-canvas.width)/2, (canvas.height-height)/2 + Number(y.value)*(height-canvas.height)/2, width, height);
  }
  [zoom,x,y].forEach(control => control.oninput = draw);
  crop.querySelector('[data-reset-crop]').onclick = () => { zoom.value=1; x.value=y.value=0; draw(); };
  chooser.onchange = async () => {
    const version = ++loadVersion, file = chooser.files[0];
    image=null; crop.hidden=true; feedback.textContent='';
    if (!file) return;
    if (!(/image\/(png|jpeg)/.test(file.type) || (!file.type && /\.(png|jpe?g)$/i.test(file.name))) || file.size > (sandbox ? 1 : 5)*1024*1024) { feedback.textContent='Choose a PNG or JPEG within the size limit. Export HEIC photos as JPEG first.'; return; }
    let url;
    feedback.innerHTML=loading('Preparing picture…',true);
    try {
      url = await readImage(file);
      const decoded=new Image(); decoded.src=url; await decoded.decode();
      if (!isCurrent() || version!==loadVersion) return;
      image=decoded; zoom.value=1; x.value=y.value=0; crop.hidden=false; draw(); feedback.textContent='';
    } catch { if(version===loadVersion) feedback.textContent='This image could not be opened. Choose a PNG or JPEG.'; }

  };
  canvas.onpointerdown = event => {
    if (!image || form.querySelector('[type="submit"]').disabled) return;
    const box=canvas.getBoundingClientRect();
    dragging={id:event.pointerId,x:event.clientX,y:event.clientY,offsetX:Number(x.value),offsetY:Number(y.value),ratio:canvas.width/box.width};
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = event => {
    if (!dragging || dragging.id!==event.pointerId) return;
    const size=geometry(), clamp=value=>Math.max(-1,Math.min(1,value));
    x.value=clamp(dragging.offsetX + (event.clientX-dragging.x)*dragging.ratio/Math.max(1,(size.width-canvas.width)/2));
    y.value=clamp(dragging.offsetY + (event.clientY-dragging.y)*dragging.ratio/Math.max(1,(size.height-canvas.height)/2)); draw();
  };
  canvas.onpointerup=canvas.onpointercancel=()=>{dragging=null;};
  async function save(remove) {
    if (!remove && !image) { feedback.textContent = "Choose a picture and wait for its crop preview."; return; }
    const controls = [...form.querySelectorAll("button,input")];
    controls.forEach(control => control.disabled = true);
    feedback.innerHTML = loading(remove ? "Removing picture…" : "Saving picture…", true);
    try {
      const blob = remove ? null : await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .9));
      if (!remove && !blob) throw Error("Could not crop the picture. Try again.");
      const file = blob && new File([blob], "profile-picture.jpg", {type:"image/jpeg"});
      const body = sandbox ? { image: remove ? null : await readImage(file) } : { evidenceId: remove ? null : await uploadImage(file, api, config) };
      if (!isCurrent()) return;
      await api("/api/profile/picture", { method: "POST", body });
      if (isCurrent()) { await onSaved(); await mountPicture(container, { api, esc, loading, isCurrent, name, sandbox, config, onSaved }); }
    } catch (error) { if (form.isConnected) feedback.textContent = error.message; }
    finally { controls.forEach(control => control.disabled = false); }
  }
  form.onsubmit = event => { event.preventDefault(); save(false); };
  const remove = form.querySelector("[data-remove-picture]");
  if (remove) remove.onclick = () => save(true);
}
