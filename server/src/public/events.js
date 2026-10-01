// "Live events" section — see server/src/events/eventStore.ts.
const addEventForm = document.getElementById('add-event')
const eventSlotEl = document.getElementById('event-slot')
const eventTitleEl = document.getElementById('event-title')
const eventUrlEl = document.getElementById('event-url')
const eventStartEl = document.getElementById('event-start')
const eventSportEl = document.getElementById('event-sport')
const slotsEl = document.getElementById('slots')

const SPORT_LABELS = {
  hockey: 'Hockey',
  football: 'Football',
  basketball: 'Basketball',
  baseball: 'Baseball',
  soccer: 'Soccer',
  other: 'Other'
}

// datetime-local wants local time with no zone, e.g. "2026-09-29T19:00".
function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatWhen(ms) {
  return new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function statusBadge(event) {
  const badge = document.createElement('span')
  if (event.active && event.warm) {
    badge.className = 'badge live'
    badge.textContent = Date.now() >= event.startsAt ? 'On now' : 'Ready'
  } else if (event.active) {
    badge.className = 'badge pending'
    badge.textContent = 'Warming…'
    badge.title = 'Not playable yet — retried every minute until the stream comes up'
  } else {
    badge.className = 'badge'
    badge.textContent = 'Up next'
  }
  return badge
}

let populatedSelects = false
// Set while a URL is being edited, so the 15s auto-refresh doesn't wipe the input.
let editingEvent = false

async function loadEvents() {
  if (editingEvent) return
  try {
    const { sports, slots } = await (await fetch('/api/events')).json()

    if (!populatedSelects) {
      for (const s of slots) eventSlotEl.add(new Option(`${s.channelNumber} · ${s.name}`, s.slot))
      for (const [sport, minutes] of Object.entries(sports)) {
        eventSportEl.add(new Option(`${SPORT_LABELS[sport] ?? sport} (${minutes / 60}h)`, sport))
      }
      eventStartEl.value = toLocalInputValue(new Date())
      populatedSelects = true
    }

    const activeCount = slots.reduce((n, s) => n + s.events.length, 0)
    document.getElementById('events-count').textContent = activeCount || ''

    // One table, one row per event; a slot's name only on its first row.
    slotsEl.innerHTML = ''
    for (const s of slots) {
      const nameCell = (row) => {
        const cell = row.insertCell()
        cell.className = 'slot-name'
        const chno = document.createElement('span')
        chno.className = 'chno'
        chno.textContent = `${s.channelNumber} `
        cell.append(chno, s.name)
        cell.rowSpan = Math.max(s.events.length, 1)
      }

      if (s.events.length === 0) {
        const row = slotsEl.insertRow()
        nameCell(row)
        const empty = row.insertCell()
        empty.className = 'empty'
        empty.colSpan = 4
        empty.textContent = 'No event scheduled'
        continue
      }

      s.events.forEach((event, i) => {
        const row = slotsEl.insertRow()
        if (i === 0) nameCell(row)
        const titleCell = row.insertCell()
        const showTitle = () => {
          const url = document.createElement('div')
          url.className = 'event-url'
          url.textContent = event.url
          url.title = event.url
          titleCell.replaceChildren(event.title, url)
        }
        showTitle()
        const when = row.insertCell()
        when.className = 'when'
        when.textContent = `${formatWhen(event.startsAt)} – ${new Date(event.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        row.insertCell().appendChild(statusBadge(event))
        const removeBtn = document.createElement('button')
        removeBtn.className = 'remove'
        removeBtn.textContent = '×'
        removeBtn.title = 'Remove'
        removeBtn.addEventListener('click', async () => {
          try {
            await request('DELETE', `/api/events/${event.id}`)
            loadEvents()
          } catch (err) {
            status.textContent = `Error: ${err.message}`
          }
        })
        const actions = row.insertCell()
        actions.className = 'actions'
        actions.append(
          editButton(() => {
            editingEvent = true
            const url = document.createElement('div')
            titleCell.replaceChildren(event.title, url)
            editUrlInline(
              url,
              event.url,
              (newUrl) => request('PATCH', `/api/events/${event.id}`, { url: newUrl }),
              () => {
                editingEvent = false
                loadEvents()
              }
            )
          }),
          removeBtn
        )
      })
    }
  } catch (err) {
    status.textContent = `Error loading events: ${err.message}`
  }
}

addEventForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const title = eventTitleEl.value.trim()
  const url = eventUrlEl.value.trim()
  const startsAt = new Date(eventStartEl.value).getTime()
  if (!title || !url || !Number.isFinite(startsAt)) {
    status.textContent = 'Enter a title, a URL, and a start time.'
    return
  }
  try {
    await request('POST', '/api/events', {
      slot: Number(eventSlotEl.value),
      title,
      url,
      startsAt,
      sport: eventSportEl.value
    })
    eventTitleEl.value = ''
    eventUrlEl.value = ''
    status.textContent = `Assigned "${title}"`
    loadEvents()
  } catch (err) {
    status.textContent = `Error: ${err.message}`
  }
})

loadEvents()
// Warm status changes in the background; keep the badges current.
setInterval(loadEvents, 15000)
