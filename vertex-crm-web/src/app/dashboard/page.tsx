'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/lib/store'
import api from '@/lib/api'

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
    <div className="space-y-8 p-8">
      <h1 className="text-3xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-gray-600 text-sm">Total Leads</div>
          <div className="text-3xl font-bold">{stats.leads}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-gray-600 text-sm">Active Deals</div>
          <div className="text-3xl font-bold">{stats.deals}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-gray-600 text-sm">Contacts</div>
          <div className="text-3xl font-bold">{stats.contacts}</div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow">
          <div className="text-gray-600 text-sm">Revenue</div>
          <div className="text-3xl font-bold">${(stats.revenue / 1000).toFixed(1)}k</div>
        </div>
      </div>
    </div>
  )
}
