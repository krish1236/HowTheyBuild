export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="max-w-2xl text-center">
        <h1 className="text-4xl font-semibold tracking-tight">HowTheyBuild</h1>
        <p className="mt-4 text-lg text-neutral-600 dark:text-neutral-400">
          Citation-first Q&amp;A for software engineers. Real production stories
          from engineering blogs, postmortems, and systems papers.
        </p>
        <p className="mt-8 text-sm text-neutral-500">In development.</p>
      </div>
    </main>
  );
}
