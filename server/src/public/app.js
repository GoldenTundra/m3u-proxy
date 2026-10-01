const addFavoriteForm = document.getElementById('add-favorite')
const titleInput = document.getElementById('favorite-title-input')
const urlInput = document.getElementById('favorite-url-input')
const status = document.getElementById('status')
const favoritesEl = document.getElementById('favorites')
const playlistUrlEl = document.getElementById('playlist-url')
const guideUrlEl = document.getElementById('guide-url')
const suggestionsEl = document.getElementById('guide-suggestions')
const guideMatchEl = document.getElementById('guide-match')

// Set only when the user actually picked a suggestion — cleared on any
// further typing, so stale guide data can never attach to an edited title.
let selectedGuide = null
let searchDebounce = null

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

// Inline URL editor: swaps `cell`'s contents for an input. Enter (or Save)
// calls `save(newUrl)`; Esc/Cancel or an unchanged URL just calls `done()`.
// `done` should re-render the row. Shared with events.js.
function editUrlInline(cell, currentUrl, save, done) {
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'url-edit'
  input.value = currentUrl
  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'small'
  saveBtn.textContent = 'Save'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'small'
  cancelBtn.textContent = 'Cancel'

  const commit = async () => {
    const url = input.value.trim()
    if (!url || url === currentUrl) return done()
    saveBtn.disabled = true
    try {
      await save(url)
      status.textContent = 'URL updated — re-warming…'
    } catch (err) {
      status.textContent = `Error: ${err.message}`
    }
    done()
  }
  saveBtn.addEventListener('click', commit)
  cancelBtn.addEventListener('click', () => done())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') done()
  })

  const wrap = document.createElement('div')
  wrap.className = 'url-edit-row'
  wrap.append(input, saveBtn, cancelBtn)
  cell.replaceChildren(wrap)
  input.focus()
  input.select()
}

function editButton(onClick) {
  const btn = document.createElement('button')
  btn.className = 'remove edit'
  btn.textContent = '✎'
  btn.title = 'Edit URL'
  btn.addEventListener('click', onClick)
  return btn
}

playlistUrlEl.textContent = `${window.location.origin}/playlist.m3u`
guideUrlEl.textContent = `${window.location.origin}/guide.xml`
document.getElementById('hdhr-address').textContent = window.location.host
document.getElementById('plex-guide-url').textContent = `${window.location.origin}/plex/guide.xml`

for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById(btn.dataset.copy).textContent)
      btn.textContent = 'Copied'
    } catch {
      btn.textContent = 'Copy failed'
    }
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  })
}

// Tabs — the selected one is kept in the URL hash so a reload stays put.
const tabButtons = document.querySelectorAll('.tabs [data-tab]')

function showTab(name) {
  if (!document.getElementById(`panel-${name}`)) name = 'channels'
  for (const btn of tabButtons) {
    const active = btn.dataset.tab === name
    btn.classList.toggle('active', active)
    document.getElementById(`panel-${btn.dataset.tab}`).hidden = !active
  }
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    history.replaceState(null, '', `#${btn.dataset.tab}`)
    status.textContent = ''
    showTab(btn.dataset.tab)
  })
}
showTab(window.location.hash.slice(1))

async function loadFavorites() {
  try {
    const [favorites, warmStatus] = await Promise.all([
      fetch('/api/favorites').then((r) => r.json()),
      fetch('/api/channels/status').then((r) => r.json()).catch(() => ({}))
    ])
    favorites.sort((a, b) => (a.channelNumber ?? 0) - (b.channelNumber ?? 0))
    document.getElementById('channels-count').textContent = favorites.length
    favoritesEl.innerHTML = ''
    for (const fav of favorites) {
      const row = document.createElement('tr')

      const numberCell = document.createElement('td')
      numberCell.className = 'chno'
      numberCell.textContent = fav.channelNumber ?? ''

      const nameCell = document.createElement('td')
      nameCell.textContent = fav.title

      const urlCell = document.createElement('td')
      urlCell.className = 'url'
      urlCell.textContent = fav.url
      urlCell.title = fav.url

      const guideCell = document.createElement('td')
      guideCell.className = 'guide'
      guideCell.textContent = fav.tvgId ? '✓' : '—'
      guideCell.title = fav.tvgId ? `Guide data: ${fav.tvgName ?? fav.tvgId}` : 'No guide data mapped'

      const ws = warmStatus[fav.title]
      const warmCell = document.createElement('td')
      warmCell.className = `warm ${ws?.warm ? 'ok' : 'fail'}`
      warmCell.textContent = ws?.warm ? '✓' : '—'
      if (ws?.warm && ws.resolvedAt) {
        warmCell.title = `Warmed ${new Date(ws.resolvedAt).toLocaleTimeString()}`
      } else {
        warmCell.title = 'Not yet warmed'
      }

      const removeCell = document.createElement('td')
      removeCell.className = 'actions'
      removeCell.appendChild(
        editButton(() => {
          urlCell.classList.add('editing')
          editUrlInline(
            urlCell,
            fav.url,
            (url) => request('PATCH', `/api/favorites/${encodeURIComponent(fav.title)}`, { url }),
            loadFavorites
          )
        })
      )
      const removeBtn = document.createElement('button')
      removeBtn.className = 'remove'
      removeBtn.textContent = '×'
      removeBtn.addEventListener('click', async () => {
        try {
          await request('DELETE', `/api/favorites/${encodeURIComponent(fav.title)}`)
          loadFavorites()
        } catch (err) {
          status.textContent = `Error: ${err.message}`
        }
      })
      removeCell.appendChild(removeBtn)

      row.appendChild(numberCell)
      row.appendChild(nameCell)
      row.appendChild(urlCell)
      row.appendChild(guideCell)
      row.appendChild(warmCell)
      row.appendChild(removeCell)
      favoritesEl.appendChild(row)
    }
  } catch (err) {
    status.textContent = `Error loading favorites: ${err.message}`
  }
}

loadFavorites()

function hideSuggestions() {
  suggestionsEl.style.display = 'none'
  suggestionsEl.innerHTML = ''
}

function clearGuideMatch() {
  selectedGuide = null
  guideMatchEl.textContent = ''
}

async function searchGuide(query) {
  if (!query) {
    hideSuggestions()
    return
  }
  try {
    const matches = await (await fetch(`/api/catalog/search?q=${encodeURIComponent(query)}`)).json()
    if (matches.length === 0) {
      hideSuggestions()
      return
    }
    suggestionsEl.innerHTML = ''
    for (const match of matches) {
      const row = document.createElement('div')
      row.className = 'suggestion'
      if (match.tvgLogo) {
        const img = document.createElement('img')
        img.src = match.tvgLogo
        img.alt = ''
        row.appendChild(img)
      }
      const label = document.createElement('span')
      label.textContent = match.country ? `${match.tvgName} (${match.country})` : match.tvgName
      row.appendChild(label)
      row.addEventListener('click', () => {
        titleInput.value = match.tvgName
        selectedGuide = match
        guideMatchEl.textContent = `✓ Guide data: ${match.tvgName}`
        hideSuggestions()
      })
      suggestionsEl.appendChild(row)
    }
    suggestionsEl.style.display = 'block'
  } catch {
    hideSuggestions()
  }
}

titleInput.addEventListener('input', () => {
  clearGuideMatch()
  clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => searchGuide(titleInput.value.trim()), 250)
})

document.addEventListener('click', (event) => {
  if (event.target !== titleInput && !suggestionsEl.contains(event.target)) hideSuggestions()
})

addFavoriteForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const title = titleInput.value.trim()
  const url = urlInput.value.trim()
  if (!title || !url) {
    status.textContent = 'Enter both a title and a URL.'
    return
  }
  try {
    await request('POST', '/api/favorites', {
      title,
      url,
      tvgId: selectedGuide?.tvgId,
      tvgName: selectedGuide?.tvgName,
      tvgLogo: selectedGuide?.tvgLogo
    })
    titleInput.value = ''
    urlInput.value = ''
    clearGuideMatch()
    loadFavorites()
    status.textContent = `Saved "${title}"`
  } catch (err) {
    status.textContent = `Error: ${err.message}`
  }
})
