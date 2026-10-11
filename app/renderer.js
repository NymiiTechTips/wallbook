const shelf = document.getElementById('wallpaperShelf');
const leftRail = document.getElementById('leftRail');
const selectBtn = document.getElementById('selectBtn');
const statusText = document.getElementById('statusText');

let wallpapers = [];
let currentIndex = 0;

function getCardClass(index) {
  const distance = (index - currentIndex + wallpapers.length) % wallpapers.length;
  const normalizedDistance = distance > wallpapers.length / 2 ? distance - wallpapers.length : distance;

  if (normalizedDistance === 0) return 'is-active';
  if (Math.abs(normalizedDistance) === 1) return 'is-near';
  return 'is-far';
}

async function loadWallpapers(syncResult) {
  statusText.textContent = syncResult ? 'Mise à jour du catalogue...' : 'Chargement des wallpapers...';
  try {
    const result = syncResult || await window.wallbookAPI.syncWallpapers();
    wallpapers = result.wallpapers;

    if (!wallpapers.length) {
      throw new Error('Aucun wallpaper trouvé dans le dépôt.');
    }

    currentIndex = 0;
    renderShelf();
    renderRail();
    statusText.textContent = result.offline
      ? `${wallpapers.length} wallpapers en cache (hors ligne)`
      : result.downloaded
        ? `${wallpapers.length} wallpapers synchronisés, ${result.downloaded} mis à jour`
        : `${wallpapers.length} wallpapers à jour`;
  } catch (error) {
    statusText.textContent = error.message || 'Erreur de chargement';
    console.error(error);
  }
}

function renderShelf() {
  if (!shelf || !wallpapers.length) return;

  shelf.innerHTML = wallpapers
    .map((wallpaper, index) => {
      const className = getCardClass(index);
      return `
        <button
          class="wallpaper-slide ${className}"
          type="button"
          data-index="${index}"
          aria-label="Choisir ${wallpaper.name}"
          tabindex="0"
        >
          <img src="${wallpaper.url}" alt="${wallpaper.name}" />
          <span>${wallpaper.name}</span>
        </button>
      `;
    })
    .join('');
}

function renderRail() {
  if (!leftRail || !wallpapers.length) return;

  leftRail.innerHTML = wallpapers
    .map((wallpaper, index) => `
      <button
        class="rail-item ${index === currentIndex ? 'is-selected' : ''}"
        type="button"
        data-index="${index}"
        aria-label="Choisir ${wallpaper.name}"
      >
        <img src="${wallpaper.url}" alt="${wallpaper.name}" />
      </button>
    `)
    .join('');

  const selected = leftRail.querySelector('.rail-item.is-selected');
  if (selected) {
    selected.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function showNext(direction) {
  if (!wallpapers.length) return;
  currentIndex = (currentIndex + direction + wallpapers.length) % wallpapers.length;
  renderShelf();
  renderRail();
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault();
    showNext(1);
  }

  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault();
    showNext(-1);
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    selectCurrentWallpaper();
  }
});

shelf.addEventListener('click', (event) => {
  const card = event.target.closest('.wallpaper-slide');
  if (!card) return;

  currentIndex = Number(card.dataset.index);
  renderShelf();
  renderRail();
});

leftRail.addEventListener('click', (event) => {
  const card = event.target.closest('.rail-item');
  if (!card) return;

  currentIndex = Number(card.dataset.index);
  renderShelf();
  renderRail();
});

async function selectCurrentWallpaper() {
  const selected = wallpapers[currentIndex];
  if (!selected) return;

  statusText.textContent = 'Application du wallpaper...';
  selectBtn.disabled = true;

  try {
    await window.wallbookAPI.pickWallpaper(selected.url);
  } catch (error) {
    statusText.textContent = error?.message || 'Échec de la mise à jour';
    selectBtn.disabled = false;
    console.error(error);
  }
}

selectBtn.addEventListener('click', selectCurrentWallpaper);
window.wallbookAPI.onWallpapersSynced(loadWallpapers);

loadWallpapers();