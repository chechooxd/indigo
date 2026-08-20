# Release Notes: client-transaction-array-form

## Breaking Change: `instanceof Promise === false`

Delegate methods now return `IndigoPromise<T>` objects that implement the `Promise<T>` interface structurally rather than extending it. This change enables lazy deferred-query execution necessary for the array form of `$transaction([...])`.

**Impact**: Code checking `instanceof Promise` against delegate method return values will now return `false`. To detect async operations, use `await` directly or check for `.then()` method presence instead.

**Example**:
```typescript
const user = db.user.findUnique({ where: { id: 1 } });

// Before: true
// After: false
console.log(user instanceof Promise);

// Both before and after: these continue to work
await user;                  // Works
Promise.all([user])          // Works
user.then(u => console.log(u)) // Works
```

This is the only observable user-visible change from this session's work. All SQL execution and timing remain byte-identical to the eager behavior prior to this change.
