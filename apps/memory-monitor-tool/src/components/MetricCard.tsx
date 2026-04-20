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
    <div className="mmt-metric-card" style={{ borderTopColor: color }}>
      <div className="mmt-metric-header">
        {icon && <span className="mmt-metric-icon">{icon}</span>}
        <span className="mmt-metric-title">{title}</span>
      </div>
      <div className="mmt-metric-value">
        <span className="mmt-metric-number">{value}</span>
        {unit && <span className="mmt-metric-unit">{unit}</span>}
      </div>
      {trend && trendValue && (
        <div className="mmt-metric-trend" style={{ color: trendColor }}>
          <span>{trendIcon}</span>
          <span>{trendValue}</span>
        </div>
      )}
    </div>
  )
}

export default MetricCard
