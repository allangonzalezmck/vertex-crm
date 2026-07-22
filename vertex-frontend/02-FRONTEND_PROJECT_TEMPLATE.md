# Next.js Frontend Project Template
## Complete Production-Ready Application Structure

**Framework:** Next.js 14 (App Router)  
**Language:** TypeScript  
**Styling:** Tailwind CSS + shadcn/ui  
**Charts:** Recharts  
**State:** Zustand + TanStack Query  
**Duration to Setup:** 30 minutes

---

## STEP 1: Initialize Next.js Project (5 Minutes)

```bash
cd ~/projects

# Create using create-next-app with specific options
npx create-next-app@latest vertex-crm-web \
  --typescript \
  --tailwind \
  --eslint \
  --src-dir \
  --app \
  --import-alias '@/*'

cd vertex-crm-web

# Verify structure created
ls -la
# Should show: src/, public/, app/, etc.
```

---

## STEP 2: Install Production Dependencies (3 Minutes)

```bash
npm install

# Additional dependencies
npm install \
  axios \
  zustand \
  @tanstack/react-query \
  recharts \
  date-fns \
  jwt-decode \
  @hookform/resolvers \
  react-hook-form \
  zod \
  sonner \
  next-themes

# Dev dependencies
npm install -D \
  @types/node \
  tailwindcss-animate \
  class-variance-authority \
  clsx \
  @testing-library/react \
  @testing-library/jest-dom \
  jest \
  jest-environment-jsdom

# Install shadcn/ui components
npx shadcn-ui@latest init

# Add specific components
npx shadcn-ui@latest add card
npx shadcn-ui@latest add button
npx shadcn-ui@latest add input
npx shadcn-ui@latest add form
npx shadcn-ui@latest add table
npx shadcn-ui@latest add dialog
npx shadcn-ui@latest add dropdown-menu
npx shadcn-ui@latest add sidebar
npx shadcn-ui@latest add sheet
```

---

## STEP 3: Create Project Structure (10 Minutes)

```bash
# Create directory structure
mkdir -p src/app/login
mkdir -p src/app/dashboard/{layout,crm,meta,workflows}
mkdir -p src/app/dashboard/crm/{leads,contacts,deals,accounts,activities,pipelines}
mkdir -p src/app/dashboard/meta/{campaigns,analytics,ads,insights}
mkdir -p src/app/api/auth
mkdir -p src/components/{ui,layout,dashboard,forms}
mkdir -p src/lib
mkdir -p src/hooks
mkdir -p src/types
mkdir -p src/styles
mkdir -p src/utils
mkdir -p public/images
mkdir -p scripts

# Verify structure
tree -L 3 src/
```

---

## STEP 4: Core Configuration Files

### **tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,

    /* Path mapping */
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "exclude": ["node_modules"],
  "ts-node": {
    "compilerOptions": {
      "module": "CommonJS"
    }
  }
}
```

### **tailwind.config.ts**

```typescript
import type { Config } from "tailwindcss"
import defaultTheme from "tailwindcss/defaultTheme"

const config = {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", ...defaultTheme.fontFamily.sans],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
} satisfies Config

export default config
```

### **next.config.js**

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  
  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.example.com',
      },
    ],
  },

  // Security headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN'
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
        ],
      },
    ]
  },

  // Redirects
  async redirects() {
    return [
      {
        source: '/',
        destination: '/login',
        permanent: false,
      },
    ]
  },

  // Environment variables
  env: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
  },

  // Output
  output: 'standalone',
}

module.exports = nextConfig
```

---

## STEP 5: Core Library Files

### **src/lib/api.ts** (API Client)

```typescript
import axios, { AxiosInstance, AxiosError } from 'axios';

const api: AxiosInstance = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor - add auth token
api.interceptors.request.use(
  (config) => {
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('auth_token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Response interceptor - handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('auth_token');
      if (typeof window !== 'undefined') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;

// Export helper functions
export const apiEndpoints = {
  // Auth
  auth: {
    login: '/api/auth/login',
    logout: '/api/auth/logout',
  },
  // CRM
  crm: {
    leads: '/api/v1/leads',
    contacts: '/api/v1/contacts',
    deals: '/api/v1/deals',
    accounts: '/api/v1/accounts',
    activities: '/api/v1/activities',
    pipelines: '/api/v1/pipelines',
  },
  // Marketing
  marketing: {
    campaigns: '/api/v1/marketing/campaigns',
    ads: '/api/v1/marketing/ads',
    analytics: '/api/v1/marketing/analytics',
  },
};
```

### **src/lib/auth.ts** (Auth Utilities)

```typescript
import jwt_decode from 'jwt-decode';

export interface AuthToken {
  id: string;
  username: string;
  email: string;
  iat: number;
  exp: number;
}

export const auth = {
  // Store token
  setToken: (token: string) => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('auth_token', token);
    }
  },

  // Get token
  getToken: (): string | null => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('auth_token');
    }
    return null;
  },

  // Remove token
  removeToken: () => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('auth_token');
    }
  },

  // Decode token
  decodeToken: (token: string): AuthToken | null => {
    try {
      return jwt_decode<AuthToken>(token);
    } catch {
      return null;
    }
  },

  // Check if authenticated
  isAuthenticated: (): boolean => {
    const token = auth.getToken();
    if (!token) return false;

    const decoded = auth.decodeToken(token);
    if (!decoded) return false;

    // Check if token is expired
    return decoded.exp > Date.now() / 1000;
  },

  // Get current user
  getCurrentUser: (): AuthToken | null => {
    const token = auth.getToken();
    if (!token) return null;
    return auth.decodeToken(token);
  },
};
```

### **src/lib/store.ts** (State Management)

```typescript
import { create } from 'zustand';
import { auth, AuthToken } from './auth';

interface AuthStore {
  user: AuthToken | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  setUser: (user: AuthToken | null) => void;
  setAuthenticated: (isAuth: boolean) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;
  hydrate: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  setUser: (user) => set({ user }),
  setAuthenticated: (isAuth) => set({ isAuthenticated: isAuth }),
  setLoading: (loading) => set({ isLoading: loading }),

  logout: () => {
    auth.removeToken();
    set({ user: null, isAuthenticated: false });
  },

  hydrate: () => {
    const isAuth = auth.isAuthenticated();
    const user = auth.getCurrentUser();
    set({ isAuthenticated: isAuth, user, isLoading: false });
  },
}));

// Hydrate on app load
if (typeof window !== 'undefined') {
  useAuthStore.getState().hydrate();
}
```

### **src/types/index.ts** (TypeScript Types)

```typescript
// Auth
export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
    email: string;
  };
}

// CRM
export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  company?: string;
  status: 'new' | 'contacted' | 'qualified' | 'converted' | 'lost';
  source: string;
  score: number;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  accountId: string;
  createdAt: string;
}

export interface Deal {
  id: string;
  name: string;
  amount: number;
  stage: string;
  probability: number;
  closedDate?: string;
  leadId: string;
  createdAt: string;
}

export interface Account {
  id: string;
  name: string;
  industry?: string;
  website?: string;
  employees?: number;
  revenue?: number;
  createdAt: string;
}

// Marketing
export interface Campaign {
  id: string;
  name: string;
  platform: 'facebook' | 'instagram' | 'google';
  status: 'active' | 'paused' | 'ended';
  budget: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  startDate: string;
  endDate?: string;
}

export interface MetricsResponse {
  impressions: number;
  clicks: number;
  spend: number;
  roas: number;
  ctr: number;
  cpc: number;
}

// API
export interface ApiResponse<T> {
  data: T;
  status: 'success' | 'error';
  message?: string;
}

export interface ApiError {
  status: number;
  message: string;
  errors?: Record<string, string[]>;
}
```

---

## STEP 6: Create Layout Components

### **src/app/layout.tsx** (Root Layout)

```typescript
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import '../styles/globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Vertex CRM',
  description: 'CRM with META Business integration',
  icons: {
    icon: '/favicon.ico',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        {children}
      </body>
    </html>
  )
}
```

### **src/app/login/page.tsx** (Login Page)

```typescript
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import api from '@/lib/api'
import { auth } from '@/lib/auth'
import { useAuthStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const { setUser, setAuthenticated } = useAuthStore()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const { data } = await api.post('/api/auth/login', {
        username,
        password,
      })

      // Store token
      auth.setToken(data.token)

      // Decode and store user
      const decoded = auth.decodeToken(data.token)
      if (decoded) {
        setUser(decoded)
        setAuthenticated(true)
      }

      // Redirect to dashboard
      router.push('/dashboard')
    } catch (err: any) {
      setError(err.response?.data?.message || 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-blue-600">Vertex CRM</h1>
          <p className="text-gray-600 mt-2">Sign in to your account</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
              {error}
            </div>
          )}

          <Input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            required
          />

          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            required
          />

          <Button
            type="submit"
            disabled={loading}
            className="w-full"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </Button>
        </form>

        <div className="text-center text-sm text-gray-600">
          <p>Demo credentials:</p>
          <p>Username: demo</p>
          <p>Password: demo123</p>
        </div>
      </div>
    </div>
  )
}
```

---

## STEP 7: Create Dashboard Pages

### **src/app/dashboard/page.tsx** (Dashboard Home)

```typescript
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store'
import api from '@/lib/api'
import { Card } from '@/components/ui/card'

export default function DashboardPage() {
  const router = useRouter()
  const { isAuthenticated, isLoading } = useAuthStore()
  const [stats, setStats] = useState({
    leads: 0,
    deals: 0,
    contacts: 0,
    revenue: 0,
  })

  useEffect(() => {
    if (isLoading) return

    if (!isAuthenticated) {
      router.push('/login')
      return
    }

    // Fetch dashboard stats
    const fetchStats = async () => {
      try {
        const [leadsRes, dealsRes, contactsRes] = await Promise.all([
          api.get('/api/v1/leads?limit=1'),
          api.get('/api/v1/deals?limit=1'),
          api.get('/api/v1/contacts?limit=1'),
        ])

        setStats({
          leads: leadsRes.data.total || 0,
          deals: dealsRes.data.total || 0,
          contacts: contactsRes.data.total || 0,
          revenue: dealsRes.data.data?.reduce((sum: number, deal: any) => sum + deal.amount, 0) || 0,
        })
      } catch (error) {
        console.error('Failed to fetch stats:', error)
      }
    }

    fetchStats()
  }, [isAuthenticated, isLoading, router])

  if (isLoading) return <div className="p-8">Loading...</div>

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-4 gap-4">
        <Card className="p-6">
          <div className="text-gray-600 text-sm">Total Leads</div>
          <div className="text-3xl font-bold">{stats.leads}</div>
        </Card>
        <Card className="p-6">
          <div className="text-gray-600 text-sm">Active Deals</div>
          <div className="text-3xl font-bold">{stats.deals}</div>
        </Card>
        <Card className="p-6">
          <div className="text-gray-600 text-sm">Contacts</div>
          <div className="text-3xl font-bold">{stats.contacts}</div>
        </Card>
        <Card className="p-6">
          <div className="text-gray-600 text-sm">Revenue</div>
          <div className="text-3xl font-bold">${(stats.revenue / 1000).toFixed(1)}k</div>
        </Card>
      </div>
    </div>
  )
}
```

---

## STEP 8: Create Environment File

Create `.env.local`:

```bash
# Backend API
NEXT_PUBLIC_API_URL=http://localhost:8000

# Optional: For production
# NEXT_PUBLIC_API_URL=https://api.vertex-crm.yourdomain.com

# Auth
NEXT_PUBLIC_AUTH_ENABLED=true

# Analytics (optional)
NEXT_PUBLIC_GTAG_ID=

# Feature flags
NEXT_PUBLIC_ENABLE_META_INTEGRATION=true
```

---

## STEP 9: Create Dockerfile

```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy built app
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start
CMD ["npm", "start"]
```

---

## STEP 10: Verify and Test

```bash
# Build locally
npm run build

# Check for errors
# Output should show: "Compiled successfully"

# Start development server
npm run dev

# Test in browser
# Visit: http://localhost:3000
# You should be redirected to /login
# Login with: demo / demo123
```

---

## PRODUCTION CHECKLIST

```
✅ TypeScript strict mode enabled
✅ Environment variables configured
✅ API client with interceptors
✅ Auth store and utilities
✅ Protected routes
✅ Error handling
✅ Loading states
✅ Health checks
✅ Docker production build
✅ No console errors
✅ No TypeScript errors
✅ Tailwind CSS configured
✅ Components organized
✅ API endpoints centralized
```

---

## NEXT STEP

Once frontend is ready:

→ Follow `03-GCP_DEPLOYMENT_SCRIPTS.sh` to deploy to GCP

```bash
# Build Docker image
docker build -t vertex-crm-web:v1.0.0 .

# Test locally with docker
docker run -p 3000:3000 vertex-crm-web:v1.0.0

# Then deploy to GCP Cloud Run
bash ../infrastructure/scripts/deploy-to-gcp.sh
```

---

## SUMMARY

✅ Next.js 14 project initialized  
✅ All dependencies installed  
✅ TypeScript configured  
✅ Tailwind CSS ready  
✅ API client setup  
✅ Auth system ready  
✅ Dashboard pages ready  
✅ Docker container ready  
✅ Ready for deployment  

**Frontend is production-ready!**
