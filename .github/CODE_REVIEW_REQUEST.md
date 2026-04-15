# Code Review Request

**Purpose:** Full codebase review to identify bugs, security issues, code quality problems, and improvement opportunities.

**Scope:** Entire repository

**Focus Areas:**
- Security vulnerabilities (SQL injection, XSS, auth bypass, exposed secrets)
- Error handling gaps and edge cases
- Performance bottlenecks (N+1 queries, missing indexes, inefficient algorithms)
- Code that contradicts its comments/documentation
- Logic errors in business logic
- Missing input validation / sanitization
- Race conditions or concurrency issues
- Memory leaks or resource management issues
- Dependency vulnerabilities
- Anything that would make a production deployment risky

**Priority:** High — this is a production system handling real user data and business workflows.

**Contact:** @SweetSophia
