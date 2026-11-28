// SOURCING: React error boundaries (a class component is the only API React
// has for catching a render failure), lib/shell/failures (the record the
// recovery page lists). A custom shell or handler that throws is recorded and
// replaced by the shipped presentation (EXEC-05); the person keeps a workspace.
import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { recordFailure } from '@/lib/shell/failures'
import type { FailureArea } from '@/lib/shell/failures'

interface Props {
  area: FailureArea
  /** The contribution whose code renders inside. */
  contributionId: string
  /** What shows instead: the shipped presentation, or a placeholder that keeps the resource. */
  fallback: ReactNode
  children: ReactNode
}

export class ContributionBoundary extends Component<
  Props,
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    recordFailure(this.props.area, error, this.props.contributionId)
  }

  componentDidUpdate(previous: Props) {
    // Selecting a different contribution is a new attempt.
    if (
      previous.contributionId !== this.props.contributionId &&
      this.state.failed
    )
      this.setState({ failed: false })
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
