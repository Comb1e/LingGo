export class MalformedModelOutputError extends Error {
  constructor(
    message: string,
    readonly responseContent = '',
  ) {
    super(message)
    this.name = 'MalformedModelOutputError'
  }
}
