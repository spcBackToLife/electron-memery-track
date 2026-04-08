import React from 'react'

interface MetricCardProps {
  title: string
  value: string
  unit?: string
  trend?: 'up' | 'down' | 'stable'
  trendValue?: string
  color?: string
  icon?: string
}

const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  unit,
  trend,
  trendValue,
  color = '#646cff',
  icon,
}) => {
  const trendIcon = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'
  const trendColor = trend === 'up' ? '#ff4d4f' : trend === 'down' ? '#52c41a' : '#faad14'

  return (
    <div className="metric-card" style={{ borderTopColor: color }}>
      <div className="metric-card-header">
        {icon && <span className="metric-card-icon">{icon}</span>}
        <span className="metric-card-title">{title}</span>
      </div>
      <div className="metric-card-value">
        <span className="metric-card-number">{value}</span>
        {unit && <span className="metric-card-unit">{unit}</span>}
      </div>
      {trend && trendValue && (
        <div className="metric-card-trend" style={{ color: trendColor }}>
          <span>{trendIcon}</span>
          <span>{trendValue}</span>
        </div>
      )}
    </div>
  )
}

export default MetricCard
