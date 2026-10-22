export class NotConnectedError extends Error {
  constructor (message = 'bot is not connected') {
    super(message)
    this.name = 'NotConnectedError'
  }
}

export class InvalidMessageError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'InvalidMessageError'
  }
}

export class RateLimitError extends Error {
  constructor (message = 'rate limit exceeded') {
    super(message)
    this.name = 'RateLimitError'
  }
}
