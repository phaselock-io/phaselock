//! A pool of worker threads for CPU-heavy work a request waits on: password hashes, and the check
//! of a large mutation body.  Its threads run at a lowered priority, so the kernel preempts them
//! whenever the writer, the dispatcher, or a connection needs a core.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use tokio::sync::{OwnedSemaphorePermit, Semaphore, oneshot, watch};

/// how far below normal priority a worker runs, as a nice increment
const WORKER_NICE: i32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolError {
    /// the queue is full
    Busy,
    /// the pool has stopped
    Closed,
}

type Job = Box<dyn FnOnce() + Send>;

/// A fixed set of workers behind a queue of bounded length: a job waits in the queue, holding its
/// place until a worker takes it.  A job whose client has left before a worker reaches it is
/// skipped.  When the pool stops, the workers finish the jobs in hand and run no more.
pub struct Pool {
    queue: Arc<Semaphore>,
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    stopped: watch::Sender<bool>,
}

// lowers the calling thread's priority; Linux keeps a nice value per thread
fn lower_priority() {
    #[cfg(target_os = "linux")]
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, libc::gettid() as libc::id_t, WORKER_NICE);
    }
}

/// waits until a flag is set
pub async fn until(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|s| *s).await;
}

impl Pool {
    /// a pool of worker threads named name, behind a queue of queue jobs
    pub fn new(name: &str, workers: usize, queue: usize) -> Pool {
        let (tx, rx) = mpsc::channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        let (stopped, _) = watch::channel(false);
        let threads = (0..workers)
            .map(|i| {
                let rx = rx.clone();
                let stopped = stopped.subscribe();
                std::thread::Builder::new()
                    .name(format!("{name}-{i}"))
                    .spawn(move || {
                        lower_priority();

                        // each job in turn, until the pool drops its end of the queue; once it
                        // stops, the jobs still queued are dropped unrun
                        loop {
                            let job = rx.lock().unwrap().recv();
                            let Ok(job) = job else { return };
                            if !*stopped.borrow() {
                                job();
                            }
                        }
                    })
                    .expect("spawning a pool worker")
            })
            .collect();
        Pool {
            queue: Arc::new(Semaphore::new(queue)),
            jobs: Mutex::new(Some(tx)),
            workers: Mutex::new(threads),
            stopped,
        }
    }

    // queues f holding its place, and waits for its answer
    async fn run<T: Send + 'static>(
        &self,
        place: OwnedSemaphorePermit,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, PoolError> {
        let (started_tx, started) = oneshot::channel();
        let (tx, rx) = oneshot::channel();
        let job: Job = Box::new(move || {
            drop(place);
            if tx.is_closed() {
                return;
            }
            let _ = started_tx.send(());
            let _ = tx.send(f());
        });
        let sent = self.jobs.lock().unwrap().as_ref().map(|j| j.send(job).is_ok());
        if sent != Some(true) {
            return Err(PoolError::Closed);
        }

        // a queued job's client is answered at once when the pool stops, and a running one's
        // once its job finishes
        let mut stopped = self.stopped.subscribe();
        tokio::select! {
            biased;
            s = started => s.map_err(|_| PoolError::Closed)?,
            _ = until(&mut stopped) => return Err(PoolError::Closed),
        }
        rx.await.map_err(|_| PoolError::Closed)
    }

    /// runs f on a worker and waits for it: Busy when the queue is full
    pub async fn try_run<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, PoolError> {
        if *self.stopped.borrow() {
            return Err(PoolError::Closed);
        }
        let Ok(place) = self.queue.clone().try_acquire_owned() else { return Err(PoolError::Busy) };
        self.run(place, f).await
    }

    /// runs f on a worker and waits for it, as try_run does, but waits for room in the queue
    pub async fn queue_run<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, PoolError> {
        if *self.stopped.borrow() {
            return Err(PoolError::Closed);
        }
        let mut stopped = self.stopped.subscribe();
        let place = tokio::select! {
            s = self.queue.clone().acquire_owned() => s.map_err(|_| PoolError::Closed)?,
            _ = until(&mut stopped) => return Err(PoolError::Closed),
        };
        self.run(place, f).await
    }

    /// stops taking jobs, then waits until the jobs in hand finish
    pub async fn stop(&self) {
        self.stopped.send_replace(true);
        self.jobs.lock().unwrap().take();
        let workers = std::mem::take(&mut *self.workers.lock().unwrap());
        let _ = tokio::task::spawn_blocking(move || {
            for w in workers {
                let _ = w.join();
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    // a job that holds its worker until released, reporting when it starts
    fn holding() -> (impl FnOnce() + Send + 'static, mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (started_tx, started) = mpsc::channel();
        let (release, release_rx) = mpsc::channel::<()>();
        let run = move || {
            started_tx.send(()).unwrap();
            let _ = release_rx.recv();
        };
        (run, started, release)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_pool_bounds_its_queue() {
        let p = Arc::new(Pool::new("test", 1, 1));
        let (run, started, release) = holding();

        // the worker takes the first job and the queue holds the second; the third is refused
        let first = tokio::spawn({
            let p = p.clone();
            async move { p.try_run(run).await }
        });
        tokio::task::spawn_blocking(move || started.recv().unwrap()).await.unwrap();
        let second = tokio::spawn({
            let p = p.clone();
            async move { p.try_run(|| ()).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(p.try_run(|| ()).await, Err(PoolError::Busy));

        // once the worker is free both queued jobs finish
        release.send(()).unwrap();
        assert!(first.await.unwrap().is_ok());
        assert!(second.await.unwrap().is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_pool_skips_the_jobs_of_clients_that_left() {
        let p = Arc::new(Pool::new("test", 1, 4));
        let (run, started, release) = holding();
        let busy = tokio::spawn({
            let p = p.clone();
            async move { p.try_run(run).await }
        });
        tokio::task::spawn_blocking(move || started.recv().unwrap()).await.unwrap();

        // a job queued behind the busy worker whose client then leaves
        let ran = Arc::new(AtomicBool::new(false));
        let waiting = tokio::spawn({
            let (p, ran) = (p.clone(), ran.clone());
            async move { p.try_run(move || ran.store(true, Ordering::SeqCst)).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());

        // the worker skips its job
        release.send(()).unwrap();
        busy.await.unwrap().unwrap();
        p.try_run(|| ()).await.unwrap();
        assert!(!ran.load(Ordering::SeqCst), "the job of a client that left was run");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_pool_stops() {
        let p = Arc::new(Pool::new("test", 1, 4));
        let (run, started, release) = holding();
        let running = tokio::spawn({
            let p = p.clone();
            async move { p.try_run(run).await }
        });
        tokio::task::spawn_blocking(move || started.recv().unwrap()).await.unwrap();

        // a queued job, and then shutdown
        let ran = Arc::new(AtomicBool::new(false));
        let queued = tokio::spawn({
            let (p, ran) = (p.clone(), ran.clone());
            async move { p.try_run(move || ran.store(true, Ordering::SeqCst)).await }
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        let stopping = tokio::spawn({
            let p = p.clone();
            async move { p.stop().await }
        });

        // the queued job's client is answered at once, and its job never runs
        assert_eq!(queued.await.unwrap(), Err(PoolError::Closed));

        // the job in progress finishes, and then the workers are gone
        release.send(()).unwrap();
        running.await.unwrap().unwrap();
        stopping.await.unwrap();
        assert!(!ran.load(Ordering::SeqCst), "a queued job ran after shutdown");
        assert_eq!(p.try_run(|| ()).await, Err(PoolError::Closed));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn workers_run_below_normal_priority() {
        let p = Pool::new("test", 1, 1);
        let nice = p
            .try_run(|| unsafe { libc::getpriority(libc::PRIO_PROCESS, libc::gettid() as _) })
            .await
            .unwrap();
        let own = unsafe { libc::getpriority(libc::PRIO_PROCESS, libc::gettid() as _) };
        assert_eq!(nice, (own + WORKER_NICE).min(19));
    }
}
