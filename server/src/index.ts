import express from 'express'
import path from 'path'
import { proxyRouter } from './proxy/proxyRoutes'
import { playlistRouter, favoritesRouter } from './routes/playlist'
import { guideRouter } from './routes/guide'
import { slotRouter, eventsRouter } from './routes/events'
import { healthRouter } from './routes/health'
import { hdhrRouter } from './routes/hdhr'
import { PORT } from './config'
import { refreshAllGuides } from './guide/guideStore'
import { refreshAllChannels } from './channels/channelStore'

const app = express()

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))
app.use('/stream', proxyRouter)
app.use('/api', favoritesRouter)
app.use('/api', eventsRouter)
app.use(slotRouter)
app.use(playlistRouter)
app.use(guideRouter)
app.use(hdhrRouter)
app.use(healthRouter)

app.listen(PORT, () => {
  console.log(`m3u-proxy server listening on :${PORT}`)
})

refreshAllGuides().catch((err) => console.error('[guide] Initial refresh failed:', err))
refreshAllChannels().catch((err) => console.error('[channel] Initial refresh failed:', err))
