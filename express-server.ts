import express, { type Request, type Response, type NextFunction } from 'express'
import morgan from "morgan"
import path from 'node:path'

const PORT = Number.parseInt(process.env.PORT || '3000')

// Get base path from environment, ensuring it starts with /
const rawBasePath = process.env.VITE_BASE_URL || '/'
const basePath = rawBasePath.startsWith('/') ? rawBasePath : '/' + rawBasePath

const app = express()

const assetsDir = path.join(process.cwd(), 'dist/client/assets')
const serveAssets = express.static(assetsDir, {})

// @ts-expect-error - Dynamic import of built server output
const { default: handler } = await import('./dist/server/server.js')


app.disable("x-powered-by");

app.get("/healthcheck", (_: Request, res: Response) => {
  res.send("OK")
})

app.use(morgan("short"))

// check if we're in GDS
// we need to redirect our from from root back to
// the base url
// ~/ => ~/my-app
// Serve rewrite / to /<gds-path>
app.use((req: Request, _: Response, next: NextFunction) => {
  const pathOnly = req.path
  const segments = pathOnly.split('/').filter(Boolean)

  const svc = req.get('x-gds-service-name') || req.get('X-GDS-Service-Name')

  // Expect at least /<prefix>/assets
  if (svc && segments.length > 0 && segments[0] !== svc) {
    const newUrl = `/${svc}${req.url}`;
    req.url = newUrl;
    req.originalUrl = newUrl;
  }

  next();
})

// Serve /<prefix>/assets/* from dist/client/assets where `assets` is the second segment
app.use((req: Request, res: Response, next: NextFunction) => {
  const pathOnly = req.path
  const segments = pathOnly.split('/').filter(Boolean)

  // Expect at least /<prefix>/assets
  if (segments.length < 2 || segments[1] !== 'assets') {
    return next()
  }

  // Everything after /<prefix>/assets becomes the asset path
  const tailSegments = segments.slice(2)
  const assetPath = '/' + tailSegments.join('/')
  const finalAssetPath = assetPath === '/' ? '/' : assetPath

  const originalUrl = req.url

  req.url = finalAssetPath

  serveAssets(req, res, (err?: any) => {
    req.url = originalUrl
    if (err) return next(err)
    return next()
  })
})

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}${basePath}`)
  console.log(`Base path: ${basePath}`)
})
