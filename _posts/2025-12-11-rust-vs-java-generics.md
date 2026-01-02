---
layout: single  # Full article layout with sidebar/TOC
title: "Critical Evaluation: Generics in Rust vs Java"
date: 2025-12-11
tags: [rust, java, generics]
toc: true  # Enables TOC for this post
---

# Critical Evaluation: Generics in Rust vs Java

## Introduction
This article provides a critical evaluation of the **generics** feature in Rust and Java. The goal is not to declare one language is superior over other, but to examine this specific mechanism objectively, highlighting the strengths and limitations in each lanugage. 

A balanced engineering perspective requires acknowledging what each implementation does well while candidly address the shortcomings.

 Generics are a fundamental tool for writing reusable, type-safe code, yet Rust and Java take different approaches refelcting their distinct design philosiphies and tradeoffs. 

The analysis that follows is intended to help developers understand the differences and make an educated choice when working with either langugae in contexts where generics play a key role.

# Exploring Rust Generics: A Practical Journey with a Vehicle Factory

This article takes a hands-on approach to understanding Rust's generics by building a simple yet flexible vehicle factory. We start with basic concepts and progressively add more advanced generic features, showing how each step improves code reuse, type safety, and expressiveness.

The example revolves around vehicles (primarily cars) that can be equipped with different kinds of engines. Engines are modeled with multiple classifications, and the factory can produce batches of vehicles while supporting various customization and viewing patterns.

## Adding Generics to a Struct
The foundation of our system is a `Car` struct that can hold any type of engine, as long as that engine provides metadata.

By making `Car` generic over `T`, we allow the same vehicle struct to work with different engine representations without duplicating code.

```rust
pub trait GetMetadata {
    fn get_name(&self) -> String;
    fn get_id(&self) -> i32;
}

#[derive(Debug, Clone)]
pub struct Car<T>
where
    T: GetMetadata,
{
    id: i32,
    engine: Option<T>,
    name: String,
}
```
The where T: GetMetadata bound ensures that whatever engine type we use must be able to provide a name and ID — enforcing consistency at compile time while keeping the struct flexible.

## Add Generics to Traits

By making a trait generic over a type parameter (here `E`), we allow the trait to describe behavior that varies depending on another type — in this case, enabling any vehicle to be built with any compatible engine type `E` while keeping the method signature flexible and reusable across different implementations.
```rust
// generic build Trait- Engine can be anytype E
pub trait Build<E> {
    fn build(&mut self, engine: E, id: usize);
}
```

## Add Generics to Methods
By adding a generic type parameter T with a trait bound (where T: GetMetadata), the show_metadata function becomes reusable for any type that implements the GetMetadata trait, allowing it to call get_name() and get_id() without knowing the concrete type upfront.

```rust
fn show_metadata<T>(t: &T) 
    where T: GetMetadata {
    // call the metadat behavior
    println!("Name - {}, id - {}", t.get_name(), t.get_id());

}
```

## Add Multiple generic Parameters
We introduce two generic parameters (E for engine, T for vehicle) and use trait bounds to ensure compatibility — allowing the factory to work with any engine and any vehicle type that supports building with that engine.

```rust 
fn create_cars<E, T>(engine: &E, prototype: &T)-> impl Iterator<Item = T>
    where E: Clone + GetMetadata,
          T: Clone + Build<E> + GetMetadata
{
    // Clone the Engine 10 times
    // clone the Vehicle 10 times
    (0..10).map(move |i| {
        let mut vehicle = prototype.clone();
        let new_engine = engine.clone(); 
        vehicle.build(new_engine, i);
        vehicle
    })
}
```

## Add impl Trait in Return Position
By returning impl Iterator<Item = T>, we hide the concrete iterator type (in this case, a Map from std::ops::Range) while guaranteeing it yields values of type T — providing flexibility without exposing implementation details.

```rust
fn create_cars<E, T>(engine: &E, prototype: &T)-> impl Iterator<Item = T>
    where E: Clone + GetMetadata,
          T: Clone + Build<E> + GetMetadata
{
    // Clone the Engine 10 times
    // clone the Vehicle 10 times
    (0..10).map(move |i| {
        let mut vehicle = prototype.clone();
        let new_engine = engine.clone(); 
        vehicle.build(new_engine, i);
        vehicle
    })
}
```
## Add Lifetimes to Generics

By combining generic type parameters with lifetime parameters, we can create functions and structs that work with any type while safely borrowing data from existing objects. In the create_car_views function, the generic T allows any engine type, while the lifetime 'a ties the returned borrowed CarView<'a> structs to the input slice — enabling zero-allocation iteration over vehicles with references that the compiler guarantees remain valid for the entire lifetime of the view.

```rust
// A lighweight view into a car
// Borrows data
pub struct CarView<'a> {
    pub id: i32,
    pub name: &'a str,
    pub engine_name: &'a str,
}

//Factory that returns borrowed views
fn create_car_views<'a, T>(
    cars: &'a [Car<T>],
) -> impl Iterator<Item = CarView<'a>> + 'a
where 
    T: GetMetadata,
{
    cars.iter().map(|car| {
    // Borrow the name directly
        let name = &car.name;

        // Borrow the engine name — but get_name() returns String, so we can't borrow it directly
        // Instead, we use a static fallback for "No engine"
        let engine_name = car.engine
            .as_ref()
            .and_then(|e| {
                // We can't return &str from e.get_name().as_str() because the String is temporary
                // So we use a static string instead
                Some(match e.get_id() {
                    1 => "Gasoline (Petrol) Engine",
                    2 => "Pure Electric Motor",
                    3 => "Custom Cylinder Layout",
                    4 => "Custom Ignition",
                    _ => "Unknown Engine",
                })
        })
        .unwrap_or("No engine");

        CarView {
            id: car.id,
            name: name,
            engine_name,
        }
    })
}
```

## Add Concurrency Safety with Send and Sync
The Send + Sync bounds on T ensure the engine type is safe to share across the threads. 
```rust
async fn assemble_car<T>(engine: T) -> ThreadSafeCar<T>
where
    T: Send + Sync + GetMetadata + Clone + 'static + Debug,
{
    let car = Arc::new(ThreadSafeCar {
        id: 1,
        name: "Ford Mustang".to_string(),
        engine: Mutex::new(None),
        tyres: Mutex::new(0),
        seats: Mutex::new(0),
    });

    let car1 = Arc::clone(&car);
    let car2 = Arc::clone(&car);
    let car3 = Arc::clone(&car);

    let engine_task = task::spawn(async move {
        install_engine(car1, engine).await;
    });

    let tyres_task = task::spawn(async move {
        install_tyres(car2).await;
    });

    let seats_task = task::spawn(async move {
        install_seats(car3).await;
    });

    let _ = tokio::try_join!(engine_task, tyres_task, seats_task);

    Arc::try_unwrap(car).unwrap()
}
```
## Add Closures to generics
Rust allows functions to be generic not only over types but also over behavior, by accepting closures as parameters with trait bounds like Fn. This enables powerful, flexible algorithms that work with any callable meeting the required signature.

```rust
fn apply_calibration<T , A>(vehicle: &mut T, algorithm: A) 
where T: GetMetadata  + Calibrate + Clone,
      A: Fn(&T) -> i32 
{
    // Apply the algotihm on the vehicel type
    let calibration_specifc = algorithm(vehicle);
    vehicle.set_calibration(calibration_specifc);
}
```
The generic parameter A is bounded by Fn(&T) -> i32, meaning any closure (or function) that takes an immutable reference to T and returns an i32 can be passed. This decouples the calibration logic from the vehicle type, allowing custom algorithms to be injected at the call site.