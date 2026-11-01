import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { ArrowRight, Compass, Map, MapPin, Menu, X } from 'lucide-react'
import { DistrictProfile, DistrictsOverview } from './districts/DistrictsPage'
import { districtById } from './map/config'
import MethodologyPage from './methodology/MethodologyPage'
import AboutPage from './about/AboutPage'

const MapExplorer = lazy(() => import('./map/MapExplorer'))
const OfficialPortal = lazy(() => import('./official/OfficialPortal'))

const navigation = [
  { to: '/', label: 'Home' },
  { to: '/map', label: 'Explore Map' },
  { to: '/districts', label: 'Districts' },
  { to: '/methodology', label: 'Methodology' },
  { to: '/about', label: 'About' },
  { to: '/official/login', label: 'Official Login' },
]

function Brand() {
  return (
    <Link to="/" className="brand" aria-label="GHAT ISHARA home">
      <svg className="brand-mark" viewBox="0 0 84 48" fill="none" aria-hidden="true">
        <path d="M1 43 22 19l8 9L44 3l17 25 7-11 15 26H1Z" fill="currentColor" />
        <path d="m44 3-9 29 11-11-2-18Zm-22 16-9 18 13-12-4-6Zm46-2-5 15 9 4-4-19Z" fill="#e4eddf" />
        <path d="m44 16 2 12 11 15H39l7-9-2-18ZM30 28l-3 10 9-9-6-1Z" fill="#102b2b" />
      </svg>
      <span>GHAT <span className="text-sage">ISHARA</span></span>
    </Link>
  )
}

function Header() {
  const { pathname } = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        toggleRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onEscape)
    return () => document.removeEventListener('keydown', onEscape)
  }, [menuOpen])

  return (
    <header className="site-header">
      <div className="header-inner page-width">
        <Brand />
        <nav aria-label="Main navigation" className="desktop-nav">
          {navigation.map(({ to, label }) => (
            <NavLink key={to} to={to === '/map' && pathname === '/explore-map' ? '/explore-map' : to} end={to === '/'}>{label}</NavLink>
          ))}
        </nav>
        <Link to="/map" className="button button-green header-cta">Get Started <ArrowRight size={18} aria-hidden="true" /></Link>
        <button
          ref={toggleRef}
          type="button"
          className="menu-toggle"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menuOpen}
          aria-controls="mobile-navigation"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
      </div>
      <nav id="mobile-navigation" aria-label="Mobile navigation" className="mobile-nav" hidden={!menuOpen}>
        {navigation.map(({ to, label }) => (
          <NavLink key={to} to={to === '/map' && pathname === '/explore-map' ? '/explore-map' : to} end={to === '/'} onClick={() => setMenuOpen(false)}>{label}<ArrowRight size={16} aria-hidden="true" /></NavLink>
        ))}
      </nav>
    </header>
  )
}

function LandingPage({ entrancePlayed }: { entrancePlayed: { current: boolean } }) {
  const [revealOnMount] = useState(() => !entrancePlayed.current)
  useEffect(() => { entrancePlayed.current = true }, [entrancePlayed])

  return (
    <main id="main-content" tabIndex={-1} className={`hero page-width${revealOnMount ? ' hero-reveal' : ''}`}>
      <div className="hero-copy">
        <p className="eyebrow">Data <span>|</span> Science <span>|</span> Safer Western Ghats</p>
        <h1 className="hero-title"><span>GHAT</span><span className="text-sage">ISHARA</span></h1>
        <h2 className="hero-subtitle">Mapping Landslide Susceptibility<br className="desktop-break" /> for a Safer Tomorrow</h2>
        <p className="hero-description">
          Using geospatial data and machine learning to identify landslide-prone areas across the Western Ghats, helping communities, planners and authorities make informed decisions.
        </p>
        <div className="hero-actions flex flex-wrap items-center gap-4 sm:gap-5">
          <Link to="/map" className="button button-green explore-button"><Map size={23} strokeWidth={1.8} aria-hidden="true" />Explore the Map<ArrowRight size={20} aria-hidden="true" /></Link>
          <Link to="/about" className="button button-outline">Learn More</Link>
        </div>
      </div>
      <div className="hero-footnote">
        <p className="coverage"><span className="status-dot" aria-hidden="true" />Pune <span>·</span> Raigad <span>·</span> Ratnagiri <span>·</span> Satara</p>
        <p className="location-note"><MapPin size={13} aria-hidden="true" />Tamhini Ghat, Maharashtra</p>
      </div>
    </main>
  )
}

function NotFoundPage() {
  return <main id="main-content" tabIndex={-1} className="secondary-page page-width"><div className="secondary-content"><Compass size={36} className="text-sage mb-6" aria-hidden="true" /><p className="eyebrow">404 · Off the trail</p><h1>Let’s find your way back.</h1><p className="secondary-description">This page doesn’t exist. The mountains are still here.</p><Link className="button button-green" to="/">Return Home<ArrowRight size={18} aria-hidden="true" /></Link></div></main>
}

export default function App() {
  const { pathname } = useLocation()
  const previousPath = useRef(pathname)
  const landingEntrancePlayed = useRef(false)
  useEffect(() => {
    const officialTitles: Record<string, string> = {
      '/official/accept-invite': 'Accept invitation', '/official/dashboard': 'Official dashboard', '/official/admin': 'Official administration',
    }
    const profile = pathname.startsWith('/districts/') ? districtById(pathname.slice('/districts/'.length).replace(/\/$/, '')) : undefined
    const label = profile ? `${profile.name} district` : (pathname === '/explore-map' ? 'Explore Map' : navigation.find(item => item.to === pathname)?.label) ?? officialTitles[pathname] ?? 'Page not found'
    document.title = pathname === '/' ? 'GHAT ISHARA | A Safer Western Ghats' : `${label} | GHAT ISHARA`
    if (previousPath.current !== pathname) {
      document.getElementById('main-content')?.focus({ preventScroll: true })
      window.scrollTo({ top: 0, behavior: 'instant' })
      previousPath.current = pathname
    }
  }, [pathname])

  return (
    <div className={`site-shell ${pathname === '/' ? 'landing-shell' : 'inner-shell'}`}>
      <div className="landscape" aria-hidden="true"><img src="/images/tamhini-valley.webp" alt="" fetchPriority="high" /><div className="landscape-shade" /></div>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Header />
      <Routes>
        <Route path="/" element={<LandingPage entrancePlayed={landingEntrancePlayed} />} />
        {['/map', '/explore-map'].map(path => <Route key={path} path={path} element={<Suspense fallback={<main id="main-content" tabIndex={-1} className="secondary-page page-width"><p role="status">Opening the Map Explorer…</p></main>}><MapExplorer /></Suspense>} />)}
        <Route path="/districts" element={<DistrictsOverview />} />
        <Route path="/districts/:districtId" element={<DistrictProfile />} />
        <Route path="/methodology" element={<MethodologyPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/official/*" element={<Suspense fallback={<main id="main-content" tabIndex={-1} className="secondary-page page-width"><p role="status">Opening the official portal…</p></main>}><OfficialPortal /></Suspense>} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </div>
  )
}
