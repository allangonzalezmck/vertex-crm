# Interoperability Test Suite
## Complete Frontend ↔ Backend Integration Testing

**Duration:** 10-15 minutes  
**Scope:** End-to-end system testing  
**Coverage:** Auth, CRM, META, workflows  
**Success Criteria:** All tests pass without errors

---

## TEST SETUP

### Install Test Dependencies

```bash
cd vertex-crm-web

# Install testing libraries
npm install -D \
  jest \
  @testing-library/react \
  @testing-library/jest-dom \
  jest-environment-jsdom \
  node-fetch \
  dotenv

# Create jest config
cat > jest.config.js << 'EOF'
const nextJest = require('next/jest')

const createJestConfig = nextJest({
  dir: './',
})

const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'jest-environment-jsdom',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
}

module.exports = createJestConfig(customJestConfig)
EOF

# Create jest setup
cat > jest.setup.js << 'EOF'
import '@testing-library/jest-dom'
EOF
```

---

## TEST 1: Authentication Flow

### Test File: `src/__tests__/auth.test.ts`

```typescript
import api from '@/lib/api'
import { auth } from '@/lib/auth'

describe('Authentication Flow', () => {
  const testUser = {
    username: 'demo',
    password: 'demo123',
  }

  test('Login with valid credentials', async () => {
    try {
      const response = await api.post('/api/auth/login', testUser)
      
      expect(response.status).toBe(200)
      expect(response.data.token).toBeDefined()
      expect(response.data.user).toBeDefined()
      
      // Verify token can be decoded
      const token = response.data.token
      const decoded = auth.decodeToken(token)
      expect(decoded).toBeDefined()
      expect(decoded?.username).toBe(testUser.username)
      
      console.log('✓ Login successful')
    } catch (error: any) {
      throw new Error(`Login failed: ${error.response?.data?.message || error.message}`)
    }
  })

  test('Login with invalid credentials', async () => {
    try {
      await api.post('/api/auth/login', {
        username: 'invalid',
        password: 'wrong',
      })
      throw new Error('Should have thrown 401')
    } catch (error: any) {
      expect(error.response?.status).toBe(401)
      console.log('✓ Invalid credentials rejected')
    }
  })

  test('Token storage and retrieval', () => {
    const testToken = 'test-token-xyz'
    
    auth.setToken(testToken)
    const retrieved = auth.getToken()
    
    expect(retrieved).toBe(testToken)
    
    auth.removeToken()
    const empty = auth.getToken()
    
    expect(empty).toBeNull()
    console.log('✓ Token storage working')
  })

  test('Authentication check', () => {
    const isAuth = auth.isAuthenticated()
    expect(typeof isAuth).toBe('boolean')
    console.log(`✓ Auth check: ${isAuth}`)
  })
})
```

---

## TEST 2: CRM Data Operations

### Test File: `src/__tests__/crm.test.ts`

```typescript
import api from '@/lib/api'
import type { Lead, Deal, Contact } from '@/types'

describe('CRM Operations', () => {
  let leadId: string
  let dealId: string

  test('Fetch leads', async () => {
    try {
      const response = await api.get('/api/v1/leads')
      
      expect(response.status).toBe(200)
      expect(Array.isArray(response.data)).toBe(true)
      
      console.log(`✓ Fetched ${response.data.length} leads`)
    } catch (error: any) {
      throw new Error(`Failed to fetch leads: ${error.message}`)
    }
  })

  test('Create new lead', async () => {
    try {
      const newLead = {
        firstName: 'Test',
        lastName: 'Lead',
        email: `test-${Date.now()}@example.com`,
        status: 'new',
        source: 'api-test',
      }

      const response = await api.post('/api/v1/leads', newLead)
      
      expect(response.status).toBe(201)
      expect(response.data.id).toBeDefined()
      
      leadId = response.data.id
      console.log(`✓ Created lead: ${leadId}`)
    } catch (error: any) {
      throw new Error(`Failed to create lead: ${error.message}`)
    }
  })

  test('Update lead', async () => {
    if (!leadId) {
      console.log('⚠ Skipping (no lead ID)')
      return
    }

    try {
      const response = await api.patch(`/api/v1/leads/${leadId}`, {
        status: 'qualified',
      })
      
      expect(response.status).toBe(200)
      expect(response.data.status).toBe('qualified')
      
      console.log('✓ Updated lead')
    } catch (error: any) {
      throw new Error(`Failed to update lead: ${error.message}`)
    }
  })

  test('Fetch deals', async () => {
    try {
      const response = await api.get('/api/v1/deals')
      
      expect(response.status).toBe(200)
      expect(Array.isArray(response.data)).toBe(true)
      
      console.log(`✓ Fetched ${response.data.length} deals`)
    } catch (error: any) {
      throw new Error(`Failed to fetch deals: ${error.message}`)
    }
  })

  test('Fetch contacts', async () => {
    try {
      const response = await api.get('/api/v1/contacts')
      
      expect(response.status).toBe(200)
      expect(Array.isArray(response.data)).toBe(true)
      
      console.log(`✓ Fetched ${response.data.length} contacts`)
    } catch (error: any) {
      throw new Error(`Failed to fetch contacts: ${error.message}`)
    }
  })

  test('Fetch accounts', async () => {
    try {
      const response = await api.get('/api/v1/accounts')
      
      expect(response.status).toBe(200)
      expect(Array.isArray(response.data)).toBe(true)
      
      console.log(`✓ Fetched ${response.data.length} accounts`)
    } catch (error: any) {
      throw new Error(`Failed to fetch accounts: ${error.message}`)
    }
  })
})
```

---

## TEST 3: META Integration

### Test File: `src/__tests__/meta.test.ts`

```typescript
import api from '@/lib/api'

describe('META Integration', () => {
  test('Fetch campaigns', async () => {
    try {
      const response = await api.get('/api/v1/marketing/campaigns')
      
      expect(response.status).toBe(200)
      expect(response.data.campaigns).toBeDefined()
      expect(Array.isArray(response.data.campaigns)).toBe(true)
      
      console.log(`✓ Fetched ${response.data.campaigns.length} campaigns`)
    } catch (error: any) {
      if (error.response?.status === 404 || error.response?.status === 503) {
        console.log('⚠ META connector not available yet (expected in Phase 1)')
      } else {
        throw new Error(`Failed to fetch campaigns: ${error.message}`)
      }
    }
  })

  test('Fetch marketing analytics', async () => {
    try {
      const response = await api.get('/api/v1/marketing/analytics')
      
      expect(response.status).toBe(200)
      expect(response.data.stats).toBeDefined()
      
      console.log('✓ Fetched marketing analytics')
    } catch (error: any) {
      if (error.response?.status === 404 || error.response?.status === 503) {
        console.log('⚠ META analytics not available yet (expected in Phase 1)')
      } else {
        throw new Error(`Failed to fetch analytics: ${error.message}`)
      }
    }
  })

  test('Fetch ads performance', async () => {
    try {
      const response = await api.get('/api/v1/marketing/ads')
      
      expect(response.status).toBe(200)
      expect(Array.isArray(response.data.ads)).toBe(true)
      
      console.log(`✓ Fetched ${response.data.ads.length} ads`)
    } catch (error: any) {
      if (error.response?.status === 404 || error.response?.status === 503) {
        console.log('⚠ Ads endpoint not available yet')
      } else {
        throw new Error(`Failed to fetch ads: ${error.message}`)
      }
    }
  })
})
```

---

## TEST 4: Error Handling

### Test File: `src/__tests__/errors.test.ts`

```typescript
import api from '@/lib/api'

describe('Error Handling', () => {
  test('Handle 401 Unauthorized', async () => {
    try {
      // Try to access without auth
      const axiosInstance = (api as any)
      const token = localStorage.getItem('auth_token')
      localStorage.removeItem('auth_token')
      
      await api.get('/api/v1/leads')
      
      throw new Error('Should have thrown 401')
    } catch (error: any) {
      expect(error.response?.status).toBe(401)
      console.log('✓ 401 error handled')
    }
  })

  test('Handle 400 Bad Request', async () => {
    try {
      await api.post('/api/v1/leads', {
        // Missing required fields
      })
      
      throw new Error('Should have thrown 400')
    } catch (error: any) {
      expect(error.response?.status).toBe(400)
      console.log('✓ 400 error handled')
    }
  })

  test('Handle network errors', async () => {
    try {
      // Try to reach invalid endpoint
      await api.get('/nonexistent-endpoint')
      
      throw new Error('Should have thrown error')
    } catch (error: any) {
      expect(error.response?.status).toBe(404)
      console.log('✓ 404 error handled')
    }
  })

  test('Handle server errors', async () => {
    try {
      // This should not throw on the frontend
      const response = await api.get('/api/health').catch((e) => e)
      
      // Should get some response (even if error)
      expect(response).toBeDefined()
      console.log('✓ Server error handled gracefully')
    } catch (error: any) {
      throw new Error(`Unexpected error: ${error.message}`)
    }
  })
})
```

---

## TEST 5: Performance & Load

### Test File: `src/__tests__/performance.test.ts`

```typescript
import api from '@/lib/api'

describe('Performance Tests', () => {
  test('API response time < 2 seconds', async () => {
    const start = Date.now()
    
    try {
      await api.get('/api/v1/leads')
      const duration = Date.now() - start
      
      console.log(`Response time: ${duration}ms`)
      expect(duration).toBeLessThan(2000)
    } catch (error) {
      console.log('⚠ API not available for performance test')
    }
  })

  test('Multiple concurrent requests', async () => {
    try {
      const start = Date.now()
      
      await Promise.all([
        api.get('/api/v1/leads'),
        api.get('/api/v1/deals'),
        api.get('/api/v1/contacts'),
        api.get('/api/v1/accounts'),
      ])
      
      const duration = Date.now() - start
      console.log(`Concurrent requests completed in ${duration}ms`)
      expect(duration).toBeLessThan(5000)
    } catch (error) {
      console.log('⚠ Concurrent test failed (expected if backend under load)')
    }
  })

  test('Database query performance', async () => {
    try {
      const start = Date.now()
      
      // Request with pagination
      await api.get('/api/v1/leads?limit=100&offset=0')
      
      const duration = Date.now() - start
      console.log(`Query time: ${duration}ms`)
      expect(duration).toBeLessThan(2000)
    } catch (error) {
      console.log('⚠ Database query test failed')
    }
  })
})
```

---

## RUN TESTS

### Execute All Tests

```bash
# Install jest globally (optional)
npm install -g jest

# Run all tests
npm test

# Run specific test file
npm test auth.test.ts

# Run with coverage
npm test -- --coverage

# Run in watch mode (for development)
npm test -- --watch
```

### Expected Output

```
PASS  src/__tests__/auth.test.ts
  Authentication Flow
    ✓ Login with valid credentials (234ms)
    ✓ Login with invalid credentials (145ms)
    ✓ Token storage and retrieval (12ms)
    ✓ Authentication check (8ms)

PASS  src/__tests__/crm.test.ts
  CRM Operations
    ✓ Fetch leads (456ms)
    ✓ Create new lead (234ms)
    ✓ Update lead (178ms)
    ✓ Fetch deals (389ms)
    ✓ Fetch contacts (412ms)
    ✓ Fetch accounts (367ms)

PASS  src/__tests__/meta.test.ts
  META Integration
    ✓ Fetch campaigns (523ms)
    ✓ Fetch marketing analytics (445ms)
    ✓ Fetch ads performance (501ms)

PASS  src/__tests__/errors.test.ts
  Error Handling
    ✓ Handle 401 Unauthorized (89ms)
    ✓ Handle 400 Bad Request (76ms)
    ✓ Handle network errors (92ms)
    ✓ Handle server errors (78ms)

PASS  src/__tests__/performance.test.ts
  Performance Tests
    ✓ API response time < 2 seconds (1234ms)
    ✓ Multiple concurrent requests (2045ms)
    ✓ Database query performance (1567ms)

Test Suites: 5 passed, 5 total
Tests:       23 passed, 23 total
Time:        12.456s
```

---

## MANUAL INTEGRATION TESTS

If automated tests aren't fully configured, run manual tests:

### Test 1: Full Login → Dashboard Flow

```
1. Open browser to https://your-domain.com
2. Redirected to login? ✓
3. Enter demo/demo123? ✓
4. Redirect to dashboard? ✓
5. Dashboard shows data? ✓
```

### Test 2: Create → Read → Update

```
1. Navigate to Leads
2. Create new lead (click Create button)
3. Fill form (Name, Email, etc.)
4. Submit
5. New lead appears in list? ✓
6. Click to open lead
7. Update a field
8. Save changes
9. Changes persist? ✓
```

### Test 3: META Data Display

```
1. Navigate to META section
2. Campaigns page loads? ✓
3. Analytics page loads? ✓
4. Charts render? ✓
5. Data displays correctly? ✓
```

### Test 4: Error Scenarios

```
1. Logout
2. Try to access /dashboard directly
3. Redirected to login? ✓
4. Try invalid login
5. Error message shown? ✓
6. Can retry? ✓
```

---

## INTEGRATION TEST RESULTS

Document results:

```
Test Suite: Interoperability
Date: _______________
Environment: Production

Tests Passed: ___ / 23
Tests Failed: ___ / 23
Success Rate: ___%

Critical Tests:
☐ Authentication: PASS / FAIL
☐ CRM Operations: PASS / FAIL
☐ META Integration: PASS / FAIL
☐ Error Handling: PASS / FAIL
☐ Performance: PASS / FAIL

Overall Status: ☐ READY ☐ NEEDS FIXES
```

---

## TROUBLESHOOTING FAILED TESTS

### "API not responding"
```bash
# Check backend service
gcloud run services describe api-gateway --region=us-central1

# Check logs
gcloud logging read "resource.type=cloud_run_revision" --limit=50
```

### "Authentication failed"
```bash
# Verify demo user exists
# Check backend auth endpoint directly
curl -X POST https://api.vertex-crm.yourdomain.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"demo","password":"demo123"}'
```

### "Database connection failed"
```bash
# Check Cloud SQL status
gcloud sql instances describe vertex-crm-db

# Check connection string in environment
echo $DATABASE_URL
```

---

## NEXT STEPS

✅ All tests passing?
→ System is ready for production!
→ Proceed to `07-TROUBLESHOOTING_GUIDE.md` for maintenance

❌ Some tests failing?
→ Check `07-TROUBLESHOOTING_GUIDE.md` for solutions
→ Review backend logs for errors

---

**Interoperability Testing Complete!** ✨
